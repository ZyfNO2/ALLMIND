import { splitRubyText } from '../../../../core/ruby-text'

export default function ReplyText({ text }: { text: string }) {
  return <>{splitRubyText(text).map((part, index) => part.annotation ? <ruby key={index}>{part.text}<rt>{part.annotation}</rt></ruby> : part.text)}</>
}
