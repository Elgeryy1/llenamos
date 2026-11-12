export function ErrorNotice({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="my-4 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm leading-relaxed text-destructive"
    >
      {message}
    </p>
  )
}
