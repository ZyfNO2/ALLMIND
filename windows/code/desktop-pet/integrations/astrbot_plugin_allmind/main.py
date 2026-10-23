"""Thin ALLMIND capability client.

Wiki uses a scoped service. Presets replace the complete contexts sequence,
including the current message and any trailing depth-zero instructions.
A prepare failure stops the event instead of sending a reply without context.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
from astrbot.core.utils.astrbot_path import get_astrbot_data_path
from typing import Any
from urllib import error, request

from astrbot.api import logger, star
from astrbot.api.event import filter
from astrbot.core.agent.message import strip_checkpoint_messages


@star.register(
    "astrbot_plugin_allmind",
    "ALLMIND",
    "Scoped Wiki, ordered Preset contexts, and final-turn receipts for AstrBot.",
    "0.2.0",
)
class AllmindCapability(star.Star):
    def __init__(self, context: star.Context, config: star.AstrBotConfig | None = None) -> None:
        super().__init__(context)
        self.config = config or {}
        self._recorded: set[str] = set()
        self._prepared: dict[str, dict[str, Any]] = {}
        self._projection_file = Path(get_astrbot_data_path()) / "plugin_data" / "allmind" / "projection.json"
        self._projections = json.loads(self._projection_file.read_text(encoding="utf-8")) if self._projection_file.exists() else {}

    def _base(self) -> str:
        return str(self.config.get("allmind_base_url", "")).rstrip("/")

    def _token(self) -> str:
        return str(self.config.get("capability_token", "")).strip()

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        base, token = self._base(), self._token()
        if not base or not token:
            raise RuntimeError("ALLMIND capability endpoint is not configured")
        req = request.Request(
            base + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise RuntimeError("ALLMIND capability failed: " + detail) from exc

    def _identity(self, event: Any) -> dict[str, str]:
        platform = str(event.get_platform_name())
        conversation = str(event.unified_msg_origin)
        sender = str(event.get_sender_id())
        message_id = str(getattr(event.message_obj, "message_id", "")) or str(id(event))
        return {
            "eventKey": hashlib.sha256(json.dumps([platform, conversation, sender, message_id], ensure_ascii=False).encode()).hexdigest(),
            "platform": platform,
            "conversationKey": conversation,
            "senderKey": sender,
        }

    @staticmethod
    def _signature(row: dict[str, Any]) -> str:
        canonical = {key: row[key] for key in ("role", "content", "tool_calls", "tool_call_id", "name") if row.get(key) is not None}
        return hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

    def _history(self, event: Any, contexts: list[dict[str, Any]]) -> list[dict[str, Any]]:
        history = strip_checkpoint_messages(contexts)
        projection = self._projections.get(str(event.unified_msg_origin), [])
        signatures = [self._signature(row) for row in history]
        # AstrBot persists the complete provider-facing sequence. Strip only the
        # exact previously emitted prefix/suffix, never user text matching a regex.
        for start in range(len(projection)):
            segment = projection[start:]
            if segment and signatures[:len(segment)] == [row[0] for row in segment]:
                return [row for index, row in enumerate(history) if index >= len(segment) or segment[index][1]]
        if any(row[0] in signatures for row in projection if not row[1]):
            raise RuntimeError("Persisted preset projection changed; start a new session to avoid duplicate instructions")
        return history

    def _save_projection(self, event: Any, messages: list[dict[str, Any]], keep: list[bool]) -> None:
        if len(messages) != len(keep):
            raise RuntimeError("Preset projection length mismatch")
        self._projections[str(event.unified_msg_origin)] = [[self._signature(row), retain] for row, retain in zip(messages, keep)]
        self._projection_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._projection_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._projections), encoding="utf-8")
        temporary.replace(self._projection_file)

    @filter.on_llm_request()
    async def on_llm_request(self, event: Any, req: Any) -> None:
        identity = self._identity(event)
        try:
            parts = getattr(req, "extra_user_content_parts", []) or []
            if any(not isinstance(getattr(part, "text", None), str) for part in parts):
                raise RuntimeError("Preset input contains unsupported non-text parts")
            current = req.prompt or event.get_message_str()
            additions = [part.text for part in parts if part.text not in (current, event.get_message_str())]
            current = "\n".join([current, *additions])
            prepared = await asyncio.to_thread(self._post,
                "/api/memory-book/v1/astrbot/prepare",
                {**identity, "message": current, "history": self._history(event, req.contexts or [])})
            self._prepared[identity["eventKey"]] = prepared
            if prepared.get("preset", {}).get("status") == "assembled":
                if req.image_urls or getattr(req, "audio_urls", []):
                    raise RuntimeError("Preset adapter currently accepts text/tool histories only")
                self._save_projection(event, prepared["messages"], prepared["historyKeep"])
                req.contexts = prepared["messages"]
                req.system_prompt = ""
                req.extra_user_content_parts = []
                req.prompt = None  # all current/tail messages are already in contexts
            else:
                req.system_prompt = ((req.system_prompt or "") + "\n" + prepared.get("systemNote", "")).strip()
        except Exception:
            event.stop_event()
            raise

    async def _record(self, event: Any, answer: str, generation: str, delivery: str) -> None:
        identity = self._identity(event)
        if identity["eventKey"] in self._recorded:
            return
        prepared = self._prepared.get(identity["eventKey"])
        if not prepared:
            return
        await asyncio.to_thread(self._post,
            "/api/memory-book/v1/astrbot/record",
            {
                **identity,
                "recordToken": prepared["recordToken"],
                "answer": answer,
                "generation": generation,
                "delivery": delivery,
            },
        )
        self._recorded.add(identity["eventKey"])
        self._prepared.pop(identity["eventKey"], None)
        if len(self._recorded) > 4096:
            self._recorded.clear()  # server ledger remains durable

    @filter.on_agent_done()
    async def on_agent_done(self, event: Any, run_context: Any, response: Any) -> None:
        # Chat API streaming returns before after_message_sent. The agent finish
        # hook is the event that actually runs. It is not a platform delivery receipt.
        if str(event.get_platform_name()) != "webchat":
            return
        answer = ""
        text = getattr(response, "completion_text", None) if response is not None else None
        if isinstance(text, str):
            answer = text
        stopped = bool(event.is_stopped()) if hasattr(event, "is_stopped") else False
        await self._record(event, answer, "unknown" if stopped or not answer.strip() else "completed", "unknown")

    @filter.after_message_sent()
    async def after_message_sent(self, event: Any) -> None:
        if str(event.get_platform_name()) == "webchat":
            return
        result = event.get_result() if hasattr(event, "get_result") else None
        answer = result.get_plain_text() if result is not None and hasattr(result, "get_plain_text") else ""
        await self._record(event, answer, "completed" if answer else "unknown", "accepted")
