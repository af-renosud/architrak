import { describe, it, expect, vi } from "vitest";
import {
  deleteProjectWithRetentionCheck,
  ProjectRetentionError,
  ProjectNotFoundError,
  type ProjectDeletionExecutor,
} from "../services/project.service";

function makeExec(overrides: Partial<ProjectDeletionExecutor> = {}): ProjectDeletionExecutor {
  return {
    projectExists: vi.fn().mockResolvedValue(true),
    lockChildContainers: vi.fn().mockResolvedValue(undefined),
    countInvoices: vi.fn().mockResolvedValue(0),
    countSituations: vi.fn().mockResolvedValue(0),
    countCertificats: vi.fn().mockResolvedValue(0),
    deleteProject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("deleteProjectWithRetentionCheck", () => {
  it("deletes the project when it has no retained financial records", async () => {
    const exec = makeExec();
    await deleteProjectWithRetentionCheck(42, exec);
    expect(exec.deleteProject).toHaveBeenCalledWith(42);
  });

  it("blocks deletion when invoices remain and cites the legal retention rule", async () => {
    const exec = makeExec({ countInvoices: vi.fn().mockResolvedValue(3) });
    await expect(deleteProjectWithRetentionCheck(42, exec)).rejects.toBeInstanceOf(
      ProjectRetentionError
    );
    await expect(deleteProjectWithRetentionCheck(42, exec)).rejects.toThrow(/L123-22/);
    await expect(deleteProjectWithRetentionCheck(42, exec)).rejects.toThrow(/10 years/);
    expect(exec.deleteProject).not.toHaveBeenCalled();
  });

  it("blocks deletion when situations remain", async () => {
    const exec = makeExec({ countSituations: vi.fn().mockResolvedValue(1) });
    await expect(deleteProjectWithRetentionCheck(7, exec)).rejects.toBeInstanceOf(
      ProjectRetentionError
    );
    expect(exec.deleteProject).not.toHaveBeenCalled();
  });

  it("blocks deletion when certificats remain", async () => {
    const exec = makeExec({ countCertificats: vi.fn().mockResolvedValue(2) });
    await expect(deleteProjectWithRetentionCheck(9, exec)).rejects.toBeInstanceOf(
      ProjectRetentionError
    );
    expect(exec.deleteProject).not.toHaveBeenCalled();
  });

  it("reports the per-table retained counts on the thrown error", async () => {
    const exec = makeExec({
      countInvoices: vi.fn().mockResolvedValue(2),
      countSituations: vi.fn().mockResolvedValue(5),
      countCertificats: vi.fn().mockResolvedValue(1),
    });
    try {
      await deleteProjectWithRetentionCheck(42, exec);
      expect.fail("expected ProjectRetentionError");
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectRetentionError);
      const e = err as ProjectRetentionError;
      expect(e.code).toBe("PROJECT_RETENTION_BLOCKED");
      expect(e.retained).toEqual({ invoices: 2, situations: 5, certificats: 1 });
    }
  });

  it("throws ProjectNotFoundError when the project does not exist", async () => {
    const exec = makeExec({ projectExists: vi.fn().mockResolvedValue(false) });
    await expect(deleteProjectWithRetentionCheck(404, exec)).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
    expect(exec.deleteProject).not.toHaveBeenCalled();
  });

  it("acquires the project lock (projectExists) BEFORE counting or deleting (closes TOCTOU)", async () => {
    // Concurrency contract: projectExists is the lock-acquiring step
    // (SELECT ... FOR UPDATE on the project row). It must run first so
    // any concurrent insert of an invoice/situation/certificat referencing
    // this project is blocked on the FK key-share lock until our delete
    // commits or rolls back.
    const calls: string[] = [];
    const exec: ProjectDeletionExecutor = {
      projectExists: vi.fn(async () => {
        calls.push("lockProject");
        return true;
      }),
      lockChildContainers: vi.fn(async () => {
        calls.push("lockDevis");
      }),
      countInvoices: vi.fn(async () => {
        calls.push("countInvoices");
        return 0;
      }),
      countSituations: vi.fn(async () => {
        calls.push("countSituations");
        return 0;
      }),
      countCertificats: vi.fn(async () => {
        calls.push("countCertificats");
        return 0;
      }),
      deleteProject: vi.fn(async () => {
        calls.push("delete");
      }),
    };
    await deleteProjectWithRetentionCheck(1, exec);
    // Both the project row and the devis rows must be locked before any
    // count is taken, otherwise a concurrent inserter could slip a
    // financial record in between count and delete.
    expect(calls[0]).toBe("lockProject");
    expect(calls[1]).toBe("lockDevis");
    expect(calls.indexOf("lockDevis")).toBeLessThan(calls.indexOf("countSituations"));
    expect(calls.indexOf("lockProject")).toBeLessThan(calls.indexOf("countInvoices"));
    expect(calls.indexOf("lockProject")).toBeLessThan(calls.indexOf("countCertificats"));
    expect(calls[calls.length - 1]).toBe("delete");
  });

  it("does not delete or lock children when project does not exist", async () => {
    const exec = makeExec({ projectExists: vi.fn().mockResolvedValue(false) });
    await expect(deleteProjectWithRetentionCheck(404, exec)).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
    expect(exec.lockChildContainers).not.toHaveBeenCalled();
    expect(exec.deleteProject).not.toHaveBeenCalled();
  });
});

describe("project.service tx executor (lock semantics)", () => {
  it("issues SELECT ... FOR UPDATE when checking project existence", async () => {
    // Verifies the production tx executor wraps the existence check in a
    // row-level lock so the count + delete cannot race a concurrent insert.
    const queries: string[] = [];
    const fakeTx: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              for: (mode: string) => {
                queries.push(`select-for-${mode}`);
                return Promise.resolve([{ id: 1 }]);
              },
            }),
          }),
        }),
      }),
    };
    const { makeTxExecutor } = await import("../services/project.service");
    const exec = makeTxExecutor(fakeTx);
    await exec.projectExists(1);
    expect(queries).toContain("select-for-update");
  });

  it("locks every devis row for the project (situations FK to devis, not projects)", async () => {
    // Without this lock, a concurrent transaction could insert a new
    // situation against an existing devis between our count and our
    // delete, and the cascade-on-devis-delete would then silently wipe
    // a retained financial record.
    let forCalledWith: string | null = null;
    const fakeTx: any = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: (mode: string) => {
              forCalledWith = mode;
              return Promise.resolve([{ id: 10 }, { id: 11 }]);
            },
          }),
        }),
      }),
    };
    const { makeTxExecutor } = await import("../services/project.service");
    const exec = makeTxExecutor(fakeTx);
    await exec.lockChildContainers(42);
    expect(forCalledWith).toBe("update");
  });
});
