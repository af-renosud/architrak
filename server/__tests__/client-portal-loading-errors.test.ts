import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { renderClientPortalShell } from "../routes/client-portal-shell";

it.each([
  [401, "sign-in session"], [404, "no longer available"],
  [410, "has expired"], [500, "could not be loaded"],
])("reports HTTP %s accurately", async (status, message) => {
  const html = renderClientPortalShell({mode:"preview",devisId:51});
  const source = html.slice(html.indexOf("async function loadData()"), html.indexOf("function render(data)"));
  const root = { innerHTML: "" };
  await runInNewContext(source + "\nloadData()", {
    DATA_URL: "/preview/data", document: {getElementById: () => root},
    fetch: async () => ({status, ok:false, json:async()=>({})}),
  });
  expect(root.innerHTML).toContain(message);
  if(status === 500) expect(root.innerHTML).not.toContain("Invalid or expired link");
});
