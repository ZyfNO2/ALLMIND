// Windows-only, one-shot OCR helper for the local companion perception route.
// Input: a bounded PNG/BMP byte stream on stdin. Output: one bounded JSON response on stdout.
// It never captures the screen, writes image/text files, logs recognized text, or calls a network service.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Graphics.Imaging.h>
#include <winrt/Windows.Media.Ocr.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Globalization.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {
using namespace winrt;
using namespace Windows::Graphics::Imaging;
using namespace Windows::Media::Ocr;
using namespace Windows::Storage::Streams;

constexpr size_t MAX_INPUT_BYTES = 20u * 1024u * 1024u;
constexpr uint64_t MAX_PIXELS = 40'000'000u;
constexpr size_t MAX_BLOCKS = 256;
constexpr size_t MAX_LINE_UTF8_BYTES = 4096;
constexpr size_t MAX_OUTPUT_BYTES = 1024u * 1024u;

std::string escapeJson(const std::string& value) {
  std::string out;
  out.reserve(value.size() + 8);
  for (unsigned char ch : value) {
    switch (ch) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (ch < 0x20) {
          char buf[7];
          std::snprintf(buf, sizeof(buf), "\\u%04x", ch);
          out += buf;
        } else out.push_back(static_cast<char>(ch));
    }
  }
  return out;
}

void emit(const std::string& payload) {
  const std::string line = payload.size() <= MAX_OUTPUT_BYTES
    ? payload : R"({"schemaVersion":1,"status":"failed","engine":"windows-media-ocr","reason":"ocr_output_limit"})";
  std::fwrite(line.data(), 1, line.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}

void emitUnavailable(const char* reason) {
  emit(std::string(R"({"schemaVersion":1,"status":"unavailable","engine":"windows-media-ocr","reason":")")
    + reason + R"("})");
}

void emitFailed(const char* reason) {
  emit(std::string(R"({"schemaVersion":1,"status":"failed","engine":"windows-media-ocr","reason":")")
    + reason + R"("})");
}

struct ByteScrubber {
  std::vector<uint8_t>& bytes;
  ~ByteScrubber() { if (!bytes.empty()) SecureZeroMemory(bytes.data(), bytes.size()); }
};

bool readImageBytes(std::vector<uint8_t>& bytes) {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (input == nullptr || input == INVALID_HANDLE_VALUE) return false;
  uint8_t chunk[64 * 1024];
  DWORD count = 0;
  for (;;) {
    if (!ReadFile(input, chunk, static_cast<DWORD>(sizeof(chunk)), &count, nullptr)) {
      // A closed anonymous pipe reports ERROR_BROKEN_PIPE, not a successful zero-byte read.
      // The production adapter closes stdin after writing the image, so this is the normal EOF.
      if (GetLastError() == ERROR_BROKEN_PIPE) break;
      return false;
    }
    if (count == 0) break;
    if (bytes.size() + count > MAX_INPUT_BYTES) return false;
    bytes.insert(bytes.end(), chunk, chunk + count);
  }
  return !bytes.empty();
}

std::string boundsJson(float x, float y, float width, float height) {
  std::ostringstream out;
  out << std::fixed << std::setprecision(2)
      << R"({"x":)" << x << R"(,"y":)" << y
      << R"(,"width":)" << width << R"(,"height":)" << height << '}';
  return out.str();
}

int runProbe() {
  const auto engine = OcrEngine::TryCreateFromUserProfileLanguages();
  if (!engine) {
    emitUnavailable("ocr_language_unavailable");
    return 0;
  }
  emit(std::string(R"({"schemaVersion":1,"status":"ready","engine":"windows-media-ocr","language":")")
    + escapeJson(to_string(engine.RecognizerLanguage().LanguageTag())) + R"("})");
  return 0;
}

struct OcrCandidate {
  std::string language;
  std::vector<std::string> blocks;
  size_t recognizedCodePoints = 0;
  size_t cjkCodePoints = 0;
};

size_t utf8CodePointCount(const std::string& text) {
  size_t count = 0;
  for (unsigned char byte : text) if ((byte & 0xC0u) != 0x80u) ++count;
  return count;
}

std::vector<std::pair<uint32_t, std::string>> decodeUtf8(const std::string& text) {
  std::vector<std::pair<uint32_t, std::string>> characters;
  for (size_t i = 0; i < text.size();) {
    const auto first = static_cast<unsigned char>(text[i]);
    uint32_t codePoint = first;
    size_t length = 1;
    if ((first & 0xE0u) == 0xC0u && i + 1 < text.size()) {
      codePoint = ((first & 0x1Fu) << 6) | (static_cast<unsigned char>(text[i + 1]) & 0x3Fu);
      length = 2;
    } else if ((first & 0xF0u) == 0xE0u && i + 2 < text.size()) {
      codePoint = ((first & 0x0Fu) << 12)
        | ((static_cast<unsigned char>(text[i + 1]) & 0x3Fu) << 6)
        | (static_cast<unsigned char>(text[i + 2]) & 0x3Fu);
      length = 3;
    } else if ((first & 0xF8u) == 0xF0u && i + 3 < text.size()) {
      codePoint = ((first & 0x07u) << 18)
        | ((static_cast<unsigned char>(text[i + 1]) & 0x3Fu) << 12)
        | ((static_cast<unsigned char>(text[i + 2]) & 0x3Fu) << 6)
        | (static_cast<unsigned char>(text[i + 3]) & 0x3Fu);
      length = 4;
    }
    characters.emplace_back(codePoint, text.substr(i, length));
    i += length;
  }
  return characters;
}

bool isCjkScript(uint32_t codePoint) {
  return (codePoint >= 0x3400u && codePoint <= 0x9FFFu)
    || (codePoint >= 0xF900u && codePoint <= 0xFAFFu)
    || (codePoint >= 0x20000u && codePoint <= 0x2FA1Fu)
    || (codePoint >= 0x3040u && codePoint <= 0x30FFu)
    || (codePoint >= 0xAC00u && codePoint <= 0xD7AFu);
}

size_t cjkCodePointCount(const std::string& text) {
  size_t count = 0;
  for (const auto& character : decodeUtf8(text)) if (isCjkScript(character.first)) ++count;
  return count;
}

bool isWhitespace(uint32_t codePoint) {
  return codePoint == 0x20u || (codePoint >= 0x09u && codePoint <= 0x0Du) || codePoint == 0x3000u;
}

bool isPunctuation(uint32_t codePoint) {
  return (codePoint >= 0x3000u && codePoint <= 0x303Fu)
    || (codePoint >= 0x2000u && codePoint <= 0x206Fu)
    || codePoint == ',' || codePoint == '.' || codePoint == ':' || codePoint == ';'
    || codePoint == '!' || codePoint == '?' || codePoint == '\'' || codePoint == '"';
}

std::string normalizeCjkText(const std::string& text) {
  auto characters = decodeUtf8(text);
  for (auto& character : characters) {
    // Windows OCR can convert an ASCII punctuation mark into its full-width Unicode equivalent.
    if (character.first >= 0xFF01u && character.first <= 0xFF5Eu) {
      character.first -= 0xFEE0u;
      character.second.assign(1, static_cast<char>(character.first));
    }
  }
  std::string normalized;
  for (size_t i = 0; i < characters.size(); ++i) {
    if (!isWhitespace(characters[i].first)) {
      normalized += characters[i].second;
      continue;
    }
    size_t next = i + 1;
    while (next < characters.size() && isWhitespace(characters[next].first)) ++next;
    if (normalized.empty() || next == characters.size()) { i = next - 1; continue; }
    const auto previous = decodeUtf8(normalized).back().first;
    const auto following = characters[next].first;
    const bool remove = isPunctuation(previous) || isPunctuation(following)
      || (isCjkScript(previous) && isCjkScript(following));
    if (!remove) normalized.push_back(' ');
    i = next - 1;
  }
  return normalized;
}

bool recognizeWithEngine(const OcrEngine& engine, const SoftwareBitmap& bitmap,
    uint32_t width, uint32_t height, OcrCandidate& candidate, const char*& failureReason) {
  try {
    const auto result = engine.RecognizeAsync(bitmap).get();
    const auto lines = result.Lines();
    candidate.language = to_string(engine.RecognizerLanguage().LanguageTag());
    candidate.blocks.reserve(std::min<size_t>(static_cast<size_t>(lines.Size()), MAX_BLOCKS));

    for (uint32_t lineIndex = 0; lineIndex < lines.Size(); ++lineIndex) {
      const auto line = lines.GetAt(lineIndex);
      if (candidate.blocks.size() >= MAX_BLOCKS) { failureReason = "ocr_block_limit"; return false; }
      const std::string text = to_string(line.Text());
      if (text.empty()) continue;
      if (text.size() > MAX_LINE_UTF8_BYTES) { failureReason = "ocr_text_limit"; return false; }

      bool hasBounds = false;
      float minX = 0, minY = 0, maxX = 0, maxY = 0;
      for (uint32_t wordIndex = 0; wordIndex < line.Words().Size(); ++wordIndex) {
        const auto word = line.Words().GetAt(wordIndex);
        const auto rect = word.BoundingRect();
        const float right = rect.X + rect.Width;
        const float bottom = rect.Y + rect.Height;
        if (!std::isfinite(rect.X) || !std::isfinite(rect.Y) || !std::isfinite(rect.Width)
            || !std::isfinite(rect.Height) || rect.X < 0 || rect.Y < 0
            || rect.Width <= 0 || rect.Height <= 0 || right > width + 1 || bottom > height + 1) {
          failureReason = "ocr_bounds_invalid";
          return false;
        }
        if (!hasBounds) {
          minX = rect.X; minY = rect.Y; maxX = right; maxY = bottom; hasBounds = true;
        } else {
          minX = std::min(minX, rect.X); minY = std::min(minY, rect.Y);
          maxX = std::max(maxX, right); maxY = std::max(maxY, bottom);
        }
      }
      if (!hasBounds) continue;
      const size_t lineCjkCount = cjkCodePointCount(text);
      const std::string outputText = lineCjkCount > 0 ? normalizeCjkText(text) : text;
      candidate.recognizedCodePoints += utf8CodePointCount(outputText);
      candidate.cjkCodePoints += lineCjkCount;
      candidate.blocks.push_back(std::string(R"({"text":")") + escapeJson(outputText)
        + R"(","confidence":null,"bounds":)"
        + boundsJson(minX, minY, maxX - minX, maxY - minY) + '}');
    }
    return true;
  } catch (...) {
    failureReason = "windows_media_ocr_failed";
    return false;
  }
}

int runRecognize() {
  std::vector<uint8_t> bytes;
  ByteScrubber scrubber{ bytes };
  if (!readImageBytes(bytes)) {
    emitFailed("invalid_or_oversized_image");
    return 0;
  }

  const auto profileEngine = OcrEngine::TryCreateFromUserProfileLanguages();
  if (!profileEngine) {
    emitUnavailable("ocr_language_unavailable");
    return 0;
  }

  try {
    auto stream = InMemoryRandomAccessStream();
    auto writer = DataWriter(stream);
    writer.WriteBytes(array_view<uint8_t const>(bytes.data(), bytes.data() + bytes.size()));
    writer.StoreAsync().get();
    writer.DetachStream();
    stream.Seek(0);

    const auto decoder = BitmapDecoder::CreateAsync(stream).get();
    const uint32_t width = decoder.PixelWidth();
    const uint32_t height = decoder.PixelHeight();
    if (width == 0 || height == 0 || static_cast<uint64_t>(width) * height > MAX_PIXELS) {
      emitFailed("image_dimensions_invalid");
      return 0;
    }
    const auto bitmap = decoder.GetSoftwareBitmapAsync(
      BitmapPixelFormat::Bgra8, BitmapAlphaMode::Premultiplied).get();

    // Windows.Media.Ocr.TryCreateFromUserProfileLanguages() returns one engine, usually the first
    // profile language. The fixed CK matrix also requires the locally installed Simplified Chinese
    // recognizer, so evaluate only the bounded en-US/zh-Hans-CN set when those packs exist. Prefer
    // a candidate with recognized CJK code points for CJK text; otherwise prefer en-US for Latin-only
    // text, with profile preference retained when the language-specific alternatives are unavailable.
    // No language pack is downloaded and no image leaves the machine.
    std::vector<OcrEngine> engines{ profileEngine };
    const std::string profileLanguage = to_string(profileEngine.RecognizerLanguage().LanguageTag());
    const auto availableLanguages = OcrEngine::AvailableRecognizerLanguages();
    for (uint32_t languageIndex = 0; languageIndex < availableLanguages.Size(); ++languageIndex) {
      const auto language = availableLanguages.GetAt(languageIndex);
      const std::string tag = to_string(language.LanguageTag());
      if (tag != "en-US" && tag != "zh-Hans-CN") continue;
      if (tag == profileLanguage) continue;
      const auto engine = OcrEngine::TryCreateFromLanguage(language);
      if (engine) engines.push_back(engine);
    }

    bool found = false;
    OcrCandidate best;
    const char* lastFailure = "windows_media_ocr_failed";
    for (const auto& engine : engines) {
      OcrCandidate candidate;
      const char* failureReason = "windows_media_ocr_failed";
      if (!recognizeWithEngine(engine, bitmap, width, height, candidate, failureReason)) {
        lastFailure = failureReason;
        continue;
      }
      const bool candidateHasCjk = candidate.cjkCodePoints > 0;
      const bool bestHasCjk = best.cjkCodePoints > 0;
      const bool preferCandidate = !found
        || (candidateHasCjk && !bestHasCjk)
        || (candidateHasCjk && bestHasCjk
          && (candidate.cjkCodePoints > best.cjkCodePoints
            || (candidate.cjkCodePoints == best.cjkCodePoints
              && candidate.recognizedCodePoints > best.recognizedCodePoints)))
        || (!candidateHasCjk && !bestHasCjk
          && candidate.language == "en-US" && best.language != "en-US");
      if (preferCandidate) {
        best = std::move(candidate);
        found = true;
      }
    }
    if (!found) {
      emitFailed(lastFailure);
      return 0;
    }

    std::string payload = std::string(R"({"schemaVersion":1,"status":"ok","engine":"windows-media-ocr","language":")")
      + escapeJson(best.language) + R"(","width":)" + std::to_string(width)
      + R"(,"height":)" + std::to_string(height) + R"(,"blocks":[)";
    for (size_t i = 0; i < best.blocks.size(); ++i) {
      if (i) payload.push_back(',');
      payload += best.blocks[i];
      if (payload.size() > MAX_OUTPUT_BYTES) {
        emitFailed("ocr_output_limit");
        return 0;
      }
    }
    payload += "]}";
    emit(payload);
    return 0;
  } catch (...) {
    // Exception messages can contain local paths or platform details; return only a bounded code.
    emitFailed("windows_media_ocr_failed");
    return 0;
  }
}
}

int main(int argc, char** argv) {
  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    if (argc != 2) {
      emitFailed("invalid_helper_command");
      return 0;
    }
    const std::string command = argv[1];
    if (command == "--probe") return runProbe();
    if (command == "--recognize") return runRecognize();
    emitFailed("invalid_helper_command");
    return 0;
  } catch (...) {
    emitFailed("windows_runtime_unavailable");
    return 0;
  }
}
