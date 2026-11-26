/**
 * The "current status" note on a project (2026-11-23): one line the team keeps up to date
 * ("Client wants revised rates"), shown on the board card and in the project's Details.
 *
 *   - Any user who can edit the project may set or clear it (open access, like the title).
 *   - Saving stamps who and when, bumps header_rev (open project pages pick it up on their next
 *     sync) and, after the commit, the board (every board re-reads the card).
 *   - The same text saved again changes nothing and bumps nothing.
 *
 * ⚠️ Pipeline pool only; the project row lock first (lockProject), like every project write.
 */
import { STATUS_NOTE_MAX, cleanLine, type PipelineStatusNote } from "@dashmani/shared";
import { z } from "zod";
import { pipelineWrite } from "./tx";
import { lockProject, assertWritable, type PipelineActor } from "./projects.service";
import { bumpBoard } from "./board";
import { statusNoteOf } from "./wire";
import { recordActivity } from "./activity.service";

export const statusNoteSchema = z.object({
  text: z
    .string()
    .max(STATUS_NOTE_MAX * 2)
    .transform((s) => cleanLine(s).trim())
    .pipe(z.string().max(STATUS_NOTE_MAX, `Keep it to ${STATUS_NOTE_MAX} characters`)),
});
export type StatusNoteInput = z.infer<typeof statusNoteSchema>;

export async function setStatusNote(
  actor: PipelineActor,
  projectId: string,
  input: StatusNoteInput,
): Promise<{ statusNote: PipelineStatusNote | null; headerRev: number }> {
  const out = await pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, actor.userId);
    assertWritable(row);
    if (String(row.status_note ?? "") === input.text) {
      return { changed: false, note: statusNoteOf(row), headerRev: Number(row.header_rev) };
    }
    const rows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      UPDATE pipeline_projects
         SET status_note = ${input.text},
             status_note_at = CASE WHEN ${input.text} = '' THEN NULL ELSE timezone('utc', now()) END,
             status_note_by_id = CASE WHEN ${input.text} = '' THEN NULL ELSE ${actor.userId} END,
             header_rev = header_rev + 1,
             updated_at = timezone('utc', now())
       WHERE id = ${projectId}
   RETURNING status_note, status_note_at, status_note_by_id, header_rev`;
    await recordActivity(tx, { projectId, kind: "note", actorId: actor.userId, data: { text: input.text } });
    return { changed: true, note: statusNoteOf(rows[0]), headerRev: Number(rows[0].header_rev) };
  });
  if (out.changed) await bumpBoard();
  return { statusNote: out.note, headerRev: out.headerRev };
}
