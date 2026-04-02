export interface Employee {
  id: string;
  name: string;
  email: string;
  phone?: string;
  department?: string;
  orgUnitId?: string;
  status: "active" | "inactive" | "onboarding";
  profileImageUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEmployeeRequest {
  name: string;
  email: string;
  password: string;
  phone?: string;
  orgUnitId?: string;
  roleIds: string[];
}

export interface UpdateEmployeeRequest {
  name?: string;
  phone?: string;
  orgUnitId?: string;
  status?: "active" | "inactive" | "onboarding";
  roleIds?: string[];
}
