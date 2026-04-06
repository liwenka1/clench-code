export interface TaskPacket {
  objective: string;
  scope: string;
  repo: string;
  branchPolicy: string;
  acceptanceTests: string[];
  commitPolicy: string;
  reportingContract: string;
  escalationPolicy: string;
}

export class TaskPacketValidationError extends Error {
  constructor(private readonly validationErrors: string[]) {
    super(validationErrors.join("; "));
    this.name = "TaskPacketValidationError";
  }

  errors(): string[] {
    return [...this.validationErrors];
  }
}

export class ValidatedPacket {
  constructor(private readonly validated: TaskPacket) {}

  packet(): TaskPacket {
    return this.validated;
  }

  intoInner(): TaskPacket {
    return this.validated;
  }
}

export function validatePacket(packet: TaskPacket): ValidatedPacket {
  const errors: string[] = [];

  validateRequired("objective", packet.objective, errors);
  validateRequired("scope", packet.scope, errors);
  validateRequired("repo", packet.repo, errors);
  validateRequired("branch_policy", packet.branchPolicy, errors);
  validateRequired("commit_policy", packet.commitPolicy, errors);
  validateRequired("reporting_contract", packet.reportingContract, errors);
  validateRequired("escalation_policy", packet.escalationPolicy, errors);

  packet.acceptanceTests.forEach((test, index) => {
    if (!test.trim()) {
      errors.push(`acceptance_tests contains an empty value at index ${index}`);
    }
  });

  if (errors.length > 0) {
    throw new TaskPacketValidationError(errors);
  }

  return new ValidatedPacket(packet);
}

function validateRequired(field: string, value: string, errors: string[]): void {
  if (!value.trim()) {
    errors.push(`${field} must not be empty`);
  }
}
