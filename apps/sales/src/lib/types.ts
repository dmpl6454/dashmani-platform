export interface StaffUser {
  id: string;
  name: string;
  email: string;
  /** Role names as the API returns them on login ("Admin", "Super Admin", "Sales", …). */
  roles: string[];
  designation?: string | null;
}

export interface StaffSession {
  accessToken: string;
  refreshToken: string;
  user: StaffUser;
}

/** GET /auth/portals — the portal switcher's directory. */
export interface PortalEntry { key: "internal" | "hr" | "sales"; name: string; blurb: string; url: string; access: boolean }
export interface PortalLink { key: "client" | "creators" | "jobs" | "web"; name: string; blurb: string; url: string }
export interface PortalDirectory { portals: PortalEntry[]; links: PortalLink[] }
