/** Shape helper shared by modules that show an employee reference. */
export function toEmployeeRef(
  e:
    | {
        uniqueId: string;
        employeeNumber: string;
        firstName: string;
        middleName?: string | null;
        lastName: string;
        companyEmail: string;
      }
    | null
    | undefined,
) {
  if (!e) return null;
  return {
    uniqueId: e.uniqueId,
    employeeNumber: e.employeeNumber,
    fullName: [e.firstName, e.middleName, e.lastName].filter(Boolean).join(' '),
    companyEmail: e.companyEmail,
  };
}
