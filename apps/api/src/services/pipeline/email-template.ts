/**
 * Pipeline digest email: subject, HTML and plain-text alternative (owner request 2026-09-30).
 *
 * Pure: the worker (cron/pipeline-email.cron.ts) resolves every item from the CURRENT
 * database state first and passes plain values in; nothing here reads a clock-free global
 * except `hrUrl` (HR_APP_URL, the same base the bell rows use).
 *
 * ⚠️ SAFETY. Every piece of text that came from a person — names, project titles, phase
 * names, message snippets — is HTML-escaped (escapeHtml) exactly once, at the point it
 * enters the markup; link targets are built only from server ids + HR_APP_URL and are
 * attribute-escaped too. Snippets come from notificationSnippet(), so they are already
 * token-free, whitespace-collapsed and bidi-stripped (spec §7.9). Headers (the subject) get
 * no newline. There are NO images and NO tracking pixels.
 *
 * ⚠️ LINKS. These emails come from the company's own mailbox, and anyone who can log into
 * HR (self-registration included) can put text into them: a project title, a message, a
 * display name. Mail clients auto-link bare URLs and domains in BOTH parts, so every
 * person-written string is DEFANGED (defangLinks: "https[:]//evil[.]example") before it is
 * rendered — only the "Open in Pipeline" links, built from server ids + HR_APP_URL, are
 * clickable. The in-portal bell rows are unaffected.
 */
import { DAYS_LONG, clip, dayMonth, hrUrl, projectPath, quotedTitle, shortDay } from "./notify";
import { addDaysIST } from "@dashmani/shared";

export interface DigestMention {
  messageId: string;
  /** The thread root when the message is a reply (the link opens the thread). */
  rootId: string | null;
  authorName: string;
  /** notificationSnippet(current body, directory names, SNIPPET_MAX). */
  snippet: string;
}

export type DigestItem =
  | { kind: "mention"; projectId: string; projectTitle: string; mentions: DigestMention[] }
  | { kind: "moved"; projectId: string; projectTitle: string; actorNames: string[]; fromPhase: string; toPhase: string }
  | { kind: "due_soon"; projectId: string; projectTitle: string; due: string; phase: string }
  | { kind: "due_changed"; projectId: string; projectTitle: string; actorNames: string[]; fromDue: string | null; toDue: string | null };

export interface DigestEmail {
  subject: string;
  html: string;
  text: string;
}

/** The only escaper. `&` first. Safe in element text AND in double-quoted attributes. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Break auto-linking in person-written text: "://" → "[:]//", and a dot (ASCII or the
 * ideographic / full-width forms some linkers accept) between a letter or digit and at
 * least two letters → "[.]" — every domain label a TLD can start ("evil[.]example",
 * "www[.]x[.]io", "x@y[.]com") — plus the dots of a dotted-quad address. Ordinary prose
 * ("e.g.", "i.e.", "U.S.", "v1.2", "3.5 lakh") is left alone. Lookahead only (no
 * lookbehind), linear, on inputs that are already length-bounded.
 */
export function defangLinks(s: string): string {
  return s
    .replace(/:\/\//g, "[:]//")
    .replace(/([\p{L}\p{N}])[.\u3002\uFF0E\uFF61](?=\p{L}{2})/gu, "$1[.]")
    .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, "$1[.]$2[.]$3[.]$4");
}

/** A subject line: one line, bounded. */
function oneLine(s: string, max = 180): string {
  return clip(s.replace(/[\r\n]+/g, " "), max);
}

/** "Aisha", "Aisha and Rahul", "Aisha, Rahul and 2 others". */
export function joinNames(names: string[]): string {
  const n = names.filter(Boolean);
  if (n.length === 0) return "Someone";
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]} and ${n[2]}`;
  return `${n[0]}, ${n[1]} and ${n.length - 2} others`;
}

/**
 * "due today (Sat 3 Oct)", "due tomorrow (Sat 3 Oct)", "due Monday (5 Oct)". Relative words
 * are fine in an email (it is read near send time) — but only against the SEND day, which the
 * worker passes per digest (D7). Dates carry their year when it is not `today`'s.
 */
export function dueWhen(due: string, today: string): string {
  if (due === today) return `due today (${shortDay(due, today)})`;
  if (due === addDaysIST(today, 1)) return `due tomorrow (${shortDay(due, today)})`;
  return `due ${DAYS_LONG[new Date(`${due}T00:00:00.000Z`).getUTCDay()]} (${dayMonth(due, today)})`;
}

interface Rendered {
  /** The item's one-line summary (also the single-item subject). Plain text. */
  headline: string;
  /** Detail lines (plain text). */
  details: string[];
  /** The main link. */
  url: string;
  /** Extra per-message links for a multi-mention item. */
  extraLinks: Array<{ label: string; url: string }>;
}

function render(item: DigestItem, today: string): Rendered {
  const qt = quotedTitle(item.projectTitle);
  const projectUrl = hrUrl(projectPath(item.projectId));
  switch (item.kind) {
    case "mention": {
      const ms = item.mentions;
      const authors = [...new Set(ms.map((m) => m.authorName))];
      const headline =
        ms.length === 1
          ? `${ms[0].authorName} mentioned you in ${qt}`
          : authors.length === 1
            ? `${authors[0]} mentioned you ${ms.length} times in ${qt}`
            : `You were mentioned ${ms.length} times in ${qt}`;
      const link = (m: DigestMention) => hrUrl(projectPath(item.projectId, m.messageId, m.rootId));
      return {
        headline,
        details: ms.map((m) => (ms.length === 1 || authors.length === 1 ? `“${m.snippet}”` : `${m.authorName}: “${m.snippet}”`)),
        url: link(ms[ms.length - 1]),
        extraLinks: ms.length > 1 ? ms.map((m, i) => ({ label: `Message ${i + 1}`, url: link(m) })) : [],
      };
    }
    case "moved": {
      const headline =
        item.actorNames.length === 1
          ? `${item.actorNames[0]} moved ${qt} to ${item.toPhase}`
          : `${qt} was moved to ${item.toPhase}`;
      const details = [`From ${item.fromPhase} → ${item.toPhase}`];
      if (item.actorNames.length > 1) details.push(`Moved by ${joinNames(item.actorNames)}`);
      return { headline, details, url: projectUrl, extraLinks: [] };
    }
    case "due_soon":
      return {
        headline: `${qt} is ${dueWhen(item.due, today)}`,
        details: [`Phase: ${item.phase}`],
        url: projectUrl,
        extraLinks: [],
      };
    case "due_changed": {
      const who = item.actorNames.length === 1 ? item.actorNames[0] : null;
      const from = item.fromDue ? shortDay(item.fromDue, today) : null;
      const to = item.toDue ? shortDay(item.toDue, today) : null;
      let headline: string;
      if (to === null) headline = who ? `${who} removed the due date of ${qt}` : `The due date of ${qt} was removed`;
      else if (from === null) headline = who ? `${who} set the due date of ${qt} to ${to}` : `The due date of ${qt} was set to ${to}`;
      else headline = who ? `${who} changed the due date of ${qt} to ${to}` : `The due date of ${qt} changed to ${to}`;
      const details = [to === null ? `Was ${from}` : from === null ? `No due date before` : `Was ${from} → now ${to}`];
      if (!who) details.push(`Changed by ${joinNames(item.actorNames)}`);
      return { headline, details, url: projectUrl, extraLinks: [] };
    }
  }
}

/**
 * Why this email came, one line per reason present. Following explains itself; a mention
 * says it is delivered even without following (as the bell is — spec §7.3), so the
 * "unfollow to stop" advice never promises something it cannot do.
 */
export function digestFooter(items: DigestItem[]): string[] {
  const followed = new Set(items.filter((i) => i.kind !== "mention").map((i) => i.projectId));
  const lines: string[] = [];
  if (followed.size === 1) {
    lines.push("You're receiving this because you follow this project in the Pipeline. Unfollow it there to stop these updates.");
  } else if (followed.size > 1) {
    lines.push("You're receiving this because you follow these projects in the Pipeline. Unfollow a project there to stop its updates.");
  }
  if (items.some((i) => i.kind === "mention")) {
    lines.push("You were @mentioned in a Pipeline message. Mention emails arrive even if you don't follow the project.");
  }
  return lines;
}

/**
 * One digest for one recipient. `items` must be non-empty. `today` is the IST date key at
 * SEND time — computed per digest by the worker, never once per tick (a tick can cross IST
 * midnight): relative due words and the year rule are computed against it.
 */
export function renderPipelineDigest(o: { recipientName: string; items: DigestItem[]; today: string }): DigestEmail {
  const rendered = o.items.map((it) => {
    const r = render(it, o.today);
    // Person-written text is in the headline and details only; the links are ours.
    return { it, r: { ...r, headline: defangLinks(r.headline), details: r.details.map(defangLinks) } };
  });
  const subject = oneLine(rendered.length === 1 ? rendered[0].r.headline : `Pipeline: ${rendered.length} updates`);
  const heading = rendered.length === 1 ? "Pipeline update" : `${rendered.length} Pipeline updates`;
  const firstName = defangLinks(clip(o.recipientName.split(" ")[0] || o.recipientName, 40) || "there");
  const footer = digestFooter(o.items);

  const itemHtml = rendered
    .map(({ r }) => {
      const details = r.details
        .map((d) => `<p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:#444;">${escapeHtml(d)}</p>`)
        .join("");
      const extra = r.extraLinks.length
        ? `<p style="margin:8px 0 0;font-size:13px;">${r.extraLinks
            .map((l) => `<a href="${escapeHtml(l.url)}" style="color:#4338ca;text-decoration:underline;">${escapeHtml(l.label)}</a>`)
            .join(" &middot; ")}</p>`
        : "";
      return (
        `<div style="border-top:1px solid #eeeeee;padding:16px 0;">` +
        `<p style="margin:0;font-size:15px;line-height:1.45;font-weight:600;color:#1a1a1a;">${escapeHtml(r.headline)}</p>` +
        details +
        extra +
        `<p style="margin:12px 0 0;"><a href="${escapeHtml(r.url)}" style="display:inline-block;background:#1a1a1a;color:#ffffff;` +
        `padding:8px 16px;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;">Open in Pipeline &rarr;</a></p>` +
        `</div>`
      );
    })
    .join("");

  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">` +
    `<div style="max-width:600px;margin:0 auto;background:#ffffff;">` +
    `<div style="background:#1a1a1a;color:#ffffff;padding:18px 24px;">` +
    `<p style="margin:0;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.7;">Digital Sukoon Pipeline</p>` +
    `<h1 style="margin:4px 0 0;font-size:18px;font-weight:600;">${escapeHtml(heading)}</h1></div>` +
    `<div style="padding:8px 24px 16px;">` +
    `<p style="margin:16px 0;font-size:14px;color:#1a1a1a;">Hi ${escapeHtml(firstName)},</p>` +
    itemHtml +
    `</div>` +
    `<div style="padding:16px 24px;background:#f8f9fa;font-size:12px;line-height:1.5;color:#777777;">${footer.map(escapeHtml).join("<br>")}</div>` +
    `</div></body></html>`;

  const textItems = rendered
    .map(({ r }) => {
      const lines = [`• ${r.headline}`, ...r.details.map((d) => `  ${d}`)];
      for (const l of r.extraLinks) lines.push(`  ${l.label}: ${l.url}`);
      lines.push(`  Open in Pipeline: ${r.url}`);
      return lines.join("\n");
    })
    .join("\n\n");
  const text = `Hi ${firstName},\n\n${textItems}\n\n--\n${footer.join("\n")}\n`;

  return { subject, html, text };
}
