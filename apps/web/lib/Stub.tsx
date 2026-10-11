"use client";

import { splitToken } from "./api";

/** The token slip — notched tear-off edges, big tabular numerals. */
export function Stub({ token, name, meta, kind = "wait", big, actions }: { token: string; name: string; meta?: React.ReactNode; kind?: "wait" | "next" | "consult"; big?: boolean; actions?: React.ReactNode }) {
  const t = splitToken(token);
  return (
    <div className={`stub ${kind === "wait" ? "" : kind} ${big ? "big" : ""}`}>
      <div className="tk" aria-label={`Token ${token}`}>{t.s && <span className="s">{t.s}</span>}<span className="n">{t.n}</span></div>
      <div className="who"><div className="name">{name}</div>{meta && <div className="meta">{meta}</div>}</div>
      <div className="act">{actions}</div>
    </div>
  );
}
