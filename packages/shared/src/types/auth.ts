export interface JwtPayload {
  userId: string;
  email: string;
  roles: string[];
  type: "employee" | "client" | "hr";
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; name: string; email: string; roles: string[] };
}

export interface RefreshRequest {
  refreshToken: string;
}
