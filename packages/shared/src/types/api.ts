export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta?: {
    cursor?: string;
    has_more?: boolean;
    total?: number;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: { field: string; message: string }[];
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;
