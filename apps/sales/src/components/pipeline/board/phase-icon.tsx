"use client";
/**
 * An icon for a board phase. Phases are DATA (pipeline_phases), never a code enum, so the icon is
 * picked from the phase's name and any phase we don't recognise gets a plain circle.
 */
import { CalendarDays, CircleCheck, CircleDot, Eye, FileText, Flag, Radio, Rocket, type LucideIcon } from "lucide-react";

const BY_NAME: Array<[RegExp, LucideIcon]> = [
  [/brief/i, FileText],
  [/plan/i, CalendarDays],
  [/production|progress|shoot|edit/i, Rocket],
  [/review/i, Eye],
  [/approv/i, CircleCheck],
  [/live|publish|post/i, Radio],
  [/done|complete|closed/i, Flag],
];

export function phaseIcon(name: string): LucideIcon {
  return BY_NAME.find(([re]) => re.test(name))?.[1] ?? CircleDot;
}
