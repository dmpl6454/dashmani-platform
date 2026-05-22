import { z } from "zod";
import { safeString } from "../utils/sanitize";

export const generateOfferLetterSchema = z.object({
  employeeId:      z.string().uuid("Invalid employee"),
  designation:     safeString.pipe(z.string().min(2, "Designation is required").max(200)),
  department:      safeString.pipe(z.string().max(200)).optional(),
  salary:          z.coerce.number().positive("Salary must be a positive number"),
  probationMonths: z.coerce.number().int().min(0).max(24).optional(),
  location:        safeString.pipe(z.string().max(200)).optional(),
  offerDate:       z.coerce.date(),
  joiningDate:     z.coerce.date(),
});

export type GenerateOfferLetterInput = z.infer<typeof generateOfferLetterSchema>;
