'use client';

/**
 * The agent's working document, rendered light.
 *
 * `evaluation.brief` is markdown-ish (`#`, `##`, `- [x]`, `**`); this turns it
 * into quiet, readable lines without a markdown dependency. Shared by the
 * Overview stand card and the project map's plain view.
 */

function stripBold(value: string): string {
  return value.replace(/\*\*/g, '').replace(/_/g, '');
}

export function BriefLines({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="mapcard__brief">
      {lines.map((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('# ')) return null; // duplicates the card title
        if (trimmed.startsWith('## ')) return <h4 key={index}>{trimmed.slice(3)}</h4>;
        const check = trimmed.match(/^- \[(x|\?| )\] (.*)$/);
        if (check) {
          const mark = check[1] === 'x' ? '✓' : check[1] === '?' ? '✋' : '○';
          const tone = check[1] === 'x' ? 'ok' : check[1] === '?' ? 'warn' : 'muted';
          return (
            <p key={index} className={`mapcard__brief-line mapcard__brief-line--${tone}`}>
              <span className="mapcard__brief-mark">{mark}</span>
              {stripBold(check[2])}
            </p>
          );
        }
        if (trimmed.startsWith('- ')) {
          return (
            <p key={index} className="mapcard__brief-line">
              <span className="mapcard__brief-mark mapcard__brief-mark--dot">·</span>
              {stripBold(trimmed.slice(2))}
            </p>
          );
        }
        if (!trimmed) return null;
        return (
          <p key={index} className="mapcard__brief-line mapcard__brief-line--plain">
            {stripBold(trimmed)}
          </p>
        );
      })}
    </div>
  );
}
