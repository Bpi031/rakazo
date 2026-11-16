import { expect, test } from "@playwright/test";
import type { CallDoctor, CallRequestRow } from "@rakazo/contracts";
import { captureScreenshot } from "./helpers";

const row: CallRequestRow = {
  id: "request-1",
  doctorId: "doctor-1",
  doctorCode: "D01",
  doctorName: "Doctor One",
  date: "2026-12-03",
  type: "no_call",
  shift: "Night",
  text: "",
  createdAt: "2026-11-16T00:00:00Z",
  updatedAt: "2026-11-16T00:00:00Z",
};

for (const manager of [true, false]) {
  test(`Agents sidebar Call requests entry is ${manager ? "above Integrations for Managers" : "hidden for members"}`, async ({
    page,
  }, testInfo) => {
    const me = {
      userId: "fixture-user",
      spaceId: "clinic",
      name: "Fixture User",
      email: "fixture@example.test",
      canManageCallRequests: manager,
      managedServices: true,
      isDeploymentOwner: false,
      ticketBoardEnabled: false,
      developerMode: false,
      needsModel: false,
      defaultProvider: null,
      defaultModel: null,
      hostCredentialProvider: null,
      hostCredentialSource: null,
      computerHost: null,
      canChooseHostComputer: false,
      sandboxProvider: "none",
      avatarStyle: "organic",
      billingEnabled: false,
    };
    const space = {
      id: "clinic",
      name: "Clinic",
      hasContent: true,
      bots: [],
      groups: [],
      botSections: [],
    };
    const navigation = { spaces: [space], current: { bots: [], groups: [], botSections: [] } };
    await page.route("**/api/auth/**", (route) =>
      route.fulfill({
        json: route.request().url().includes("get-session")
          ? {
              user: {
                id: me.userId,
                name: me.name,
                email: me.email,
                emailVerified: true,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
              },
              session: {
                id: "fixture-session",
                userId: me.userId,
                token: "fixture-token",
                expiresAt: "2099-01-01T00:00:00Z",
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
              },
            }
          : { billing: false, registrationEnabled: false },
      }),
    );
    await page.route("**/rpc/**", (route) => {
      const procedure = new URL(route.request().url()).pathname.slice(5);
      const json =
        procedure === "bootstrap"
          ? {
              me,
              bots: [],
              groups: [],
              botSections: [],
              archivedBots: [],
              archivedGroups: [],
              thread: null,
              routines: [],
              spaces: [space],
            }
          : procedure === "me"
            ? me
            : procedure === "spaces/list"
              ? navigation
              : [];
      return route.fulfill({ json: { json } });
    });
    await page.goto("/app");
    const sidebar = page.getByTestId("bots-sidebar");
    await expect(sidebar.getByRole("combobox", { name: "Workspace", exact: true })).toBeVisible();
    const integrations = sidebar.getByRole("button", { name: "Integrations", exact: true });
    const callRequests = sidebar.getByRole("button", { name: "Call requests", exact: true });
    await expect(integrations).toBeVisible();
    if (manager) {
      await expect(callRequests).toHaveCount(1);
      await expect(callRequests).toBeVisible();
      expect(
        await integrations.evaluate((element) =>
          element.previousElementSibling?.textContent?.trim(),
        ),
      ).toBe("Call requests");
      await expect(callRequests.locator("svg.lucide-list-checks")).toHaveCount(1);
      expect(await callRequests.getAttribute("class")).toBe(
        await integrations.getAttribute("class"),
      );
      await captureScreenshot(page, testInfo, "manager-sidebar-call-requests");
      await callRequests.click();
      await expect(page).toHaveURL(/\/app\/call-requests$/);
    } else {
      await expect(callRequests).toHaveCount(0);
    }
  });
}

test("doctor link works without a Rakazo session and supports one-day requests on mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let verified = false;
  let rows: CallRequestRow[] = [];
  let rakazoSessionCalls = 0;
  await page.route("**/api/auth/**", (route) => {
    rakazoSessionCalls++;
    return route.fulfill({ status: 503, json: { error: "Rakazo account unavailable" } });
  });
  await page.route("**/api/call-requests/clinic**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/code")) {
      expect(request.postDataJSON()).toEqual({ email: "doctor@example.test" });
    } else if (path.endsWith("/verify")) {
      expect(request.postDataJSON()).toEqual({ email: "doctor@example.test", code: "123456" });
      verified = true;
    } else if (path.endsWith("/requests")) {
      expect(request.postDataJSON()).toEqual({
        date: row.date,
        type: "no_call",
        shift: "Night",
        text: "",
      });
      rows = [row];
    } else if (path.endsWith("/delete")) {
      rows = [];
    } else if (path.endsWith("/logout")) {
      verified = false;
    } else {
      return route.fulfill(
        verified
          ? {
              json: {
                doctor: { id: row.doctorId, code: row.doctorCode, name: row.doctorName },
                requests: rows,
                limit: 5,
              },
            }
          : { status: 401, json: { error: "Verify your email to continue" } },
      );
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/call-requests/clinic");
  await page.getByLabel("Registered email").fill("doctor@example.test");
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await page.getByLabel("Verification code").fill("123456");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.getByLabel("Request month").fill("2026-12");
  await page.getByLabel("Date", { exact: true }).fill(row.date);
  await page.getByLabel("Shift (optional)").fill("Night");
  await page.getByRole("button", { name: "Add request", exact: true }).click();
  await expect(page.getByText("1 / 5", { exact: true })).toBeVisible();
  await expect(page.getByText(row.date, { exact: true })).toBeVisible();
  expect(rakazoSessionCalls).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, testInfo, "doctor-call-requests-mobile");
  await page.getByRole("button", { name: `Delete request for ${row.date}`, exact: true }).click();
  await expect(page.getByText("0 / 5", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Registered email")).toBeVisible();
});

test("Manager reviews the month and copies the current table and doctor link", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.emulateMedia({ colorScheme: "dark" });
  let rows = [row];
  let doctors: CallDoctor[] = [
    {
      id: row.doctorId,
      code: row.doctorCode,
      name: row.doctorName,
      email: "doctor@example.test",
      active: true,
    },
  ];
  let managerReads = 0;
  await page.route("**/api/auth/**", (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/get-session"))
      return route.fulfill({
        json: {
          user: {
            id: "manager",
            name: "Manager",
            email: "manager@example.test",
            emailVerified: true,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
          session: {
            id: "manager-session",
            userId: "manager",
            token: "fixture-token",
            expiresAt: "2099-01-01T00:00:00Z",
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
        },
      });
    return route.fulfill({
      json: { billing: false, registrationEnabled: false, passwordAuth: true },
    });
  });
  await page.route("**/rpc/**", (route) =>
    route.fulfill({ json: { json: { me: { ticketBoardEnabled: false } } } }),
  );
  await page.route("**/api/call-requests/manage**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/doctors")) {
      for (const input of route.request().postDataJSON().doctors) {
        const previous = doctors.find((doctor) => doctor.code === input.code);
        doctors = [
          ...doctors.filter((doctor) => doctor.code !== input.code),
          { id: previous?.id ?? input.code, ...input },
        ];
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (new URL(route.request().url()).pathname.endsWith("/delete")) {
      rows = [];
      return route.fulfill({ json: { ok: true } });
    }
    managerReads++;
    return route.fulfill({
      json: {
        spaceId: "clinic",
        spaceName: "Test Clinic",
        emailDelivery: true,
        doctors,
        requests: rows,
      },
    });
  });
  await page.goto("/app/call-requests");
  await page.getByLabel("Request month").fill("2026-12");
  await expect(page.getByRole("cell", { name: "Doctor One", exact: true })).toBeVisible();
  const beforeCopy = managerReads;
  await page.getByRole("button", { name: "Copy month table", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy month table", exact: true })).toHaveText(
    "Copied",
  );
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("D01\tDoctor One\t2026-12-03\tNo call\tNight");
  expect(copied).toContain("hard constraints");
  expect(managerReads).toBeGreaterThan(beforeCopy);
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Copy doctor link", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "/call-requests/clinic",
  );
  await captureScreenshot(page, testInfo, "manager-call-requests");
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage doctors", exact: true }).click();
  const directory = page.getByRole("dialog");
  await expect(directory.getByText("doctor@example.test", { exact: true })).toBeVisible();
  await expect(directory.locator("textarea")).toHaveCount(0);
  const templateEvent = page.waitForEvent("download");
  await directory.getByText("Template", { exact: true }).click();
  expect((await templateEvent).suggestedFilename()).toBe("call-doctors-template.csv");
  const template = await page.request.get("/templates/call-doctors.csv");
  expect(await template.text()).toContain("Staff ID,Name,Email");
  await captureScreenshot(page, testInfo, "manager-doctor-directory");
  await directory.getByRole("button", { name: "Add doctor", exact: true }).click();
  await directory.getByLabel("Name", { exact: true }).fill("Doctor Two");
  await directory.getByLabel("Email", { exact: true }).fill("two@example.test");
  await directory.getByLabel("Staff ID", { exact: true }).fill("D02");
  await captureScreenshot(page, testInfo, "manager-add-doctor");
  await directory.getByRole("button", { name: "Save", exact: true }).click();
  await expect(directory.getByText("two@example.test", { exact: true })).toBeVisible();
  await directory.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("button", {
      name: `Delete request from ${row.doctorName} for ${row.date}`,
      exact: true,
    })
    .click();
  await expect(page.getByText("No requests this month.")).toBeVisible();
  await expect(page.locator("table")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "manager-empty-month");
});
