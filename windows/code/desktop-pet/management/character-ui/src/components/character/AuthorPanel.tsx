// LUI-02: 角色资料（作者元数据）与人设正文。
//
// 两个 owner、两个游标、两个保存按钮：`memory.prompt` 是人设正文的唯一权威，
// `PUT /api/characters/profile` 只写作者元数据（简介/背景/开场白/示例对话）。合并成一个
// 「保存全部」按钮会跨越两个 revision，是旧实现明确拒绝的做法。
import { useRef, useState } from 'react'
import { runtime } from '../../services/runtime'
import { useAsync } from '../../hooks/useAsync'
import { Notice } from '../Connection'
import { Spinner } from '../ui'
import { createCharacterSession, isConflict, messageOf, type OperationHolder } from './session'
import { ErrorNotice, Field, Panel, SaveRow, SuccessNotice } from './primitives'

const session = createCharacterSession(runtime)

interface AuthorFields { intro: string; scenario: string; firstMessage: string; exampleDialogue: string }

const AUTHOR_FIELDS: [Exclude<keyof AuthorFields, 'intro'>, string][] = [
  ['scenario', '背景与情境'],
  ['firstMessage', '开场白（仅展示，不计为真实对话）'],
  ['exampleDialogue', '示例对话'],
]

export default function AuthorPanel({ characterId }: { characterId: string }) {
  const loaded = useAsync(async () => {
    const [profile, prompt] = await Promise.all([runtime.profile(characterId), runtime.prompt(characterId)])
    return { profile, prompt }
  }, [characterId], undefined)
  if (loaded.error) return <ErrorNotice message={loaded.error} />
  if (!loaded.data) return <Spinner />
  return <AuthorEditor key={characterId} characterId={characterId} initial={loaded.data} />
}

function AuthorEditor({ characterId, initial }: { characterId: string; initial: { profile: any; prompt: any } }) {
  const [fieldRevision, setFieldRevision] = useState<number>(initial.profile.fieldRevision ?? 0)
  const [personaRevision, setPersonaRevision] = useState<number>(initial.prompt.revision ?? 0)
  const [fields, setFields] = useState<AuthorFields>({
    intro: initial.profile.identity?.intro ?? '',
    scenario: initial.profile.persona?.scenario ?? '',
    firstMessage: initial.profile.persona?.firstMessage ?? '',
    exampleDialogue: initial.profile.persona?.exampleDialogue ?? '',
  })
  const [persona, setPersona] = useState<string>(initial.prompt.text || '')
  const [authorState, setAuthorState] = useState({ busy: false, message: '', error: '', conflict: '' })
  const [personaState, setPersonaState] = useState({ busy: false, message: '', error: '', conflict: '' })
  const authorOp = useRef<OperationHolder>({}), personaOp = useRef<OperationHolder>({})
  // 只发送本次真正编辑过的字段：一次简介保存不能顺手回写一个过期的背景草稿。
  const edited = useRef<Record<string, string>>({})

  const edit = (key: keyof AuthorFields, value: string) => {
    setFields(current => ({ ...current, [key]: value }))
    edited.current[key] = value
  }

  async function saveAuthor() {
    setAuthorState({ busy: true, message: '', error: '', conflict: '' })
    try {
      const receipt = await session.saveAuthorMetadata({ characterId, fields: edited.current, expectedFieldRevision: fieldRevision, holder: authorOp.current })
      setFieldRevision(receipt.fieldRevision)
      // 采用服务端回读的作者字段，而不是本地草稿。
      setFields(current => ({
        intro: receipt.configuration?.identity?.intro ?? current.intro,
        scenario: receipt.configuration?.persona?.scenario ?? current.scenario,
        firstMessage: receipt.configuration?.persona?.firstMessage ?? current.firstMessage,
        exampleDialogue: receipt.configuration?.persona?.exampleDialogue ?? current.exampleDialogue,
      }))
      edited.current = {}
      authorOp.current = {}
      setAuthorState({ busy: false, message: `角色资料已保存（修订 ${receipt.fieldRevision}），运行消费以重启后为准。`, error: '', conflict: '' })
    } catch (error) {
      setAuthorState({
        busy: false, message: '',
        error: isConflict(error) ? '' : `保存失败：${messageOf(error)}`,
        conflict: isConflict(error) ? `${messageOf(error)} 草稿已保留，请重新读取后再保存。` : '',
      })
    }
  }

  async function savePersona() {
    setPersonaState({ busy: true, message: '', error: '', conflict: '' })
    try {
      const receipt = await session.savePersona({ characterId, text: persona, expectedRevision: personaRevision, holder: personaOp.current })
      setPersonaRevision(receipt.revision)
      setPersona(receipt.text ?? persona)
      personaOp.current = {}
      setPersonaState({ busy: false, message: `完整人设已保存（修订 ${receipt.revision}）。`, error: '', conflict: '' })
    } catch (error) {
      setPersonaState({
        busy: false, message: '',
        error: isConflict(error) ? '' : `保存失败：${messageOf(error)}`,
        conflict: isConflict(error) ? `${messageOf(error)} 草稿已保留，请重新读取后再保存。` : '',
      })
    }
  }

  return (
    <>
      <Panel title="角色资料" description="作者元数据由角色资料服务独立版本化；只保存本次编辑过的字段。">
        <Field id="config-intro" label="简介" value={fields.intro} maxLength={200} onChange={v => edit('intro', v)} hint="用一两行介绍这位角色。" />
        {AUTHOR_FIELDS.map(([key, label]) => (
          <Field key={key} id={`config-${key}`} label={label} value={fields[key]} multiline onChange={v => edit(key, v)} />
        ))}
        <SuccessNotice message={authorState.message} />
        <ErrorNotice message={authorState.error} />
        {authorState.conflict && <Notice>{authorState.conflict}</Notice>}
        <SaveRow busy={authorState.busy} disabled={false} onClick={() => void saveAuthor()} note={`字段修订 v${fieldRevision} · 保存只作用于本分区，并等待服务确认。`}>保存角色资料</SaveRow>
      </Panel>
      <Panel title="Persona Prompt" description="人设正文的唯一权威是 prompt owner；这里不写第二个可编辑正文。">
        <Field id="config-persona" label="完整人格设定（独立保存）" value={persona} multiline onChange={setPersona} />
        <SuccessNotice message={personaState.message} />
        <ErrorNotice message={personaState.error} />
        {personaState.conflict && <Notice>{personaState.conflict}</Notice>}
        <SaveRow busy={personaState.busy} disabled={!persona.trim()} onClick={() => void savePersona()} note={`人设修订 v${personaRevision}。`}>保存人设</SaveRow>
      </Panel>
    </>
  )
}
