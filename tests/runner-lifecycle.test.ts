import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";

import {
  createRunnerLifecycleOwner,
  registerRunnerTeardown,
  registerVerifiedIntegrationLifecycle,
} from "./runner.ts";
import {
  createIntegrationLifecycleRegistration,
  failSetup,
  importIntegrationSuites,
  runIntegrationTeardown,
} from "./runner-lifecycle.ts";

type MockOptions = {
  cleanupError?: Error;
  testCloseError?: Error;
  appCloseError?: Error;
};

function createMocks(options: MockOptions = {}) {
  let testClosed = false;
  let appClosed = false;
  const fixtureUserId = "fixture-user-1";
  const testPool = {
    query: async (sql: string) => {
      if (options.cleanupError && sql.includes("DELETE")) throw options.cleanupError;
      if (sql.includes("SELECT id FROM users WHERE email LIKE")) {
        return {
          rows: [{ id: fixtureUserId }],
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
        };
      }
      if (sql.includes("DELETE FROM users")) {
        return {
          rows: [{ id: fixtureUserId }],
          command: "DELETE",
          rowCount: 1,
          oid: 0,
          fields: [],
        };
      }
      return {
        rows: [],
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        fields: [],
      };
    },
    end: async () => {
      testClosed = true;
      if (options.testCloseError) throw options.testCloseError;
    },
  };
  const appDb = {
    pool: {
      end: async () => {
        appClosed = true;
        if (options.appCloseError) throw options.appCloseError;
      },
    },
  };
  return {
    testPool: testPool as Pick<Pool, "query" | "end">,
    appDb,
    wasTestClosed: () => testClosed,
    wasAppClosed: () => appClosed,
  };
}

async function assertTeardownErrors(options: MockOptions, expectedMessages: string[]) {
  const mocks = createMocks(options);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await assert.rejects(
      () => runIntegrationTeardown(mocks.testPool, mocks.appDb, "ss-itest-1234567890123-abcdef12"),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors.map((item) => (item as Error).message),
          expectedMessages,
        );
        return true;
      },
    );
    assert.equal(process.exitCode, 1);
    assert.equal(mocks.wasTestClosed(), true);
    assert.equal(mocks.wasAppClosed(), true);
  } finally {
    process.exitCode = previousExitCode;
  }
}

describe("runner teardown lifecycle", () => {
  it("cleans up successfully and closes both pools", async () => {
    const mocks = createMocks();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await runIntegrationTeardown(mocks.testPool, mocks.appDb, "ss-itest-1234567890123-abcdef12");
      assert.equal(process.exitCode, undefined);
      assert.equal(mocks.wasTestClosed(), true);
      assert.equal(mocks.wasAppClosed(), true);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("closes both pools when fixture cleanup fails", async () => {
    await assertTeardownErrors(
      { cleanupError: new Error("cleanup exploded") },
      ["Fixture cleanup failed: Fixture cleanup failed: Failed to delete 1 user(s): [fixture-user-1]"],
    );
  });

  it("attempts application closure when test-pool closure fails", async () => {
    await assertTeardownErrors(
      { testCloseError: new Error("test close exploded") },
      ["Test pool closure failed: test close exploded"],
    );
  });

  it("attempts test closure when application-pool closure fails", async () => {
    await assertTeardownErrors(
      { appCloseError: new Error("app close exploded") },
      ["Application pool closure failed: app close exploded"],
    );
  });

  it("preserves both pool closure failures", async () => {
    await assertTeardownErrors(
      {
        testCloseError: new Error("test close exploded"),
        appCloseError: new Error("app close exploded"),
      },
      [
        "Test pool closure failed: test close exploded",
        "Application pool closure failed: app close exploded",
      ],
    );
  });

  it("preserves cleanup and both pool closure failures", async () => {
    await assertTeardownErrors(
      {
        cleanupError: new Error("cleanup exploded"),
        testCloseError: new Error("test close exploded"),
        appCloseError: new Error("app close exploded"),
      },
      [
        "Fixture cleanup failed: Fixture cleanup failed: Failed to delete 1 user(s): [fixture-user-1]",
        "Test pool closure failed: test close exploded",
        "Application pool closure failed: app close exploded",
      ],
    );
  });

  it("rejects duplicate teardown registration", () => {
    const mocks = createMocks();
    const register = createIntegrationLifecycleRegistration(
      mocks.testPool,
      mocks.appDb,
      "ss-itest-1234567890123-abcdef12",
    );
    register();
    assert.throws(
      () => register(),
      /already been registered/,
    );
  });

  it("runs registered teardown after the first suite import fails", () => {
    const mocks = createMocks();
    describe("first suite import failure", () => {
      const register = createIntegrationLifecycleRegistration(
        mocks.testPool,
        mocks.appDb,
        "ss-itest-1234567890123-abcdef12",
      );
      register();
      it("captures the import failure", async () => {
        const previousExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
          await assert.rejects(
            () => importIntegrationSuites([
              async () => {
                throw new Error("first suite failed");
              },
              async () => undefined,
            ]),
            /first suite failed/,
          );
        } finally {
          process.exitCode = previousExitCode;
        }
      });
      after(() => {
        assert.equal(mocks.wasTestClosed(), true);
        assert.equal(mocks.wasAppClosed(), true);
      });
    });
  });

  it("runs registered teardown after the second suite import fails", () => {
    const mocks = createMocks();
    describe("second suite import failure", () => {
      const register = createIntegrationLifecycleRegistration(
        mocks.testPool,
        mocks.appDb,
        "ss-itest-1234567890123-abcdef12",
      );
      register();
      it("captures the later import failure", async () => {
        const previousExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
          await assert.rejects(
            () => importIntegrationSuites([
              async () => undefined,
              async () => {
                throw new Error("second suite failed");
              },
            ]),
            /second suite failed/,
          );
        } finally {
          process.exitCode = previousExitCode;
        }
      });
      after(() => {
        assert.equal(mocks.wasTestClosed(), true);
        assert.equal(mocks.wasAppClosed(), true);
      });
    });
  });

  it("uses the runner registration path and rejects duplicate registration", () => {
    const mocks = createMocks();
    const owner = createRunnerLifecycleOwner();
    registerRunnerTeardown(
      mocks.testPool as Pool,
      mocks.appDb,
      "ss-itest-1234567890123-abcdef12",
      owner,
    );
    assert.throws(
      () =>
        registerRunnerTeardown(
          mocks.testPool as Pool,
          mocks.appDb,
          "ss-itest-1234567890123-abcdef12",
          owner,
        ),
      /already been registered/,
    );
  });

  it("keeps the first pool active after a duplicate lifecycle attempt", () => {
    const first = createMocks();
    const second = createMocks();
    const owner = createRunnerLifecycleOwner();
    let activePool: Pool | null = null;
    let clearCalls = 0;
    const setPool = (pool: Pool) => {
      activePool = pool;
    };
    const clearPool = () => {
      clearCalls += 1;
      activePool = null;
    };

    registerVerifiedIntegrationLifecycle(
      first.testPool as Pool,
      first.appDb,
      "ss-itest-1234567890123-abcdef12",
      owner,
      setPool,
      clearPool,
    );

    assert.throws(
      () =>
        registerVerifiedIntegrationLifecycle(
          second.testPool as Pool,
          second.appDb,
          "ss-itest-1234567890123-abcdef12",
          owner,
          setPool,
          clearPool,
        ),
      /already been registered/,
    );
    assert.equal(activePool, first.testPool);
    assert.equal(clearCalls, 0);
  });

  it("closes both pools when integration-pool registration fails", async () => {
    const mocks = createMocks();
    let cleared = false;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      let registrationError: unknown;
      try {
        registerVerifiedIntegrationLifecycle(
          mocks.testPool as Pool,
          mocks.appDb,
          "ss-itest-1234567890123-abcdef12",
          createRunnerLifecycleOwner(),
          () => {
            throw new Error("pool registration exploded");
          },
          () => {
            cleared = true;
          },
        );
      } catch (error) {
        registrationError = error;
      }

      await assert.rejects(
        () =>
          failSetup(
            registrationError,
            mocks.testPool,
            mocks.appDb,
          ),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.match(
            (error.errors[0] as Error).message,
            /pool registration exploded/,
          );
          return true;
        },
      );
      assert.equal(cleared, true);
      assert.equal(process.exitCode, 1);
      assert.equal(mocks.wasTestClosed(), true);
      assert.equal(mocks.wasAppClosed(), true);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("preserves registration and clearing failures before setup cleanup", async () => {
    const mocks = createMocks();
    let registrationError: unknown;
    try {
      registerVerifiedIntegrationLifecycle(
        mocks.testPool as Pool,
        mocks.appDb,
        "ss-itest-1234567890123-abcdef12",
        createRunnerLifecycleOwner(),
        () => {
          throw new Error("registration exploded");
        },
        () => {
          throw new Error("clearing exploded");
        },
      );
    } catch (error) {
      registrationError = error;
    }

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await assert.rejects(
        () => failSetup(registrationError, mocks.testPool, mocks.appDb),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          const messages = error.errors.map((item) => (item as Error).message);
          assert.match(messages[0], /Integration setup failed: registration exploded/);
          assert.match(messages[1], /Integration setup failed: clearing exploded/);
          return true;
        },
      );
      assert.equal(process.exitCode, 1);
      assert.equal(mocks.wasTestClosed(), true);
      assert.equal(mocks.wasAppClosed(), true);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("preserves setup and pool-close failures", async () => {
    const mocks = createMocks({
      testCloseError: new Error("test close exploded"),
      appCloseError: new Error("app close exploded"),
    });
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await assert.rejects(
        () => failSetup(new Error("setup exploded"), mocks.testPool, mocks.appDb),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(
            error.errors.map((item) => (item as Error).message),
            [
              "Integration setup failed: setup exploded",
              "Setup pool cleanup failed: Test pool closure after setup failure: test close exploded",
              "Setup pool cleanup failed: Application pool closure after setup failure: app close exploded",
            ],
          );
          return true;
        },
      );
      assert.equal(process.exitCode, 1);
      assert.equal(mocks.wasTestClosed(), true);
      assert.equal(mocks.wasAppClosed(), true);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("marks suite import failures unsuccessful", async () => {
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await assert.rejects(
        () => importIntegrationSuites([async () => {
          throw new Error("suite import exploded");
        }]),
        /suite import exploded/,
      );
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
