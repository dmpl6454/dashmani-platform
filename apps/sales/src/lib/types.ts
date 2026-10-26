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
