//The page document embeds its props as `JSON.stringify(props)` inside
//`<script id="props" type="text/json">` without escaping `<`, and inserts
//it with `String.prototype.replace` (so `$&`, `$'` etc. in the data are
//interpreted). Client-supplied text such as a program name could
//therefore close the script element and run code. The OAuth pages pass
//their snapshot as one URI-encoded JSON string instead: its alphabet
//contains no `<`, `>`, `&`, `"` or `$`, so it is inert in that context,
//and the view decodes it back before rendering it as escaped React text.

export function encodeSnapshot(snapshot: unknown): string {
  return encodeURIComponent(JSON.stringify(snapshot));
}

export function decodeSnapshot<S>(value: unknown): S {
  if (typeof value !== 'string') {
    //already a plain object (e.g. rendered directly in a test)
    return value as S;
  }
  return JSON.parse(decodeURIComponent(value)) as S;
}
