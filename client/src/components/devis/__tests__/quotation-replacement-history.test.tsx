// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QuotationReplacementHistory } from "../QuotationReplacementHistory";
vi.mock("../ReviewPreviousQuotationWorkDialog", () => ({ ReviewPreviousQuotationWorkDialog: () => <div>Previous work dialog</div> }));
afterEach(cleanup);
const entries = [{ id:1,oldDevisId:12,newDevisId:19,oldLabel:"OLD",newLabel:"NEW",note:"Internal reason",actorName:"Architect",createdAt:"2026-11-20T10:00:00Z" }];
it.each([12,19])("hides replacement information until explicitly revealed for quotation %s", devisId => {
  render(<QuotationReplacementHistory entries={entries} devisId={devisId} projectId="4" />);
  const reveal = screen.getByText("Replacement history (1)");
  expect(reveal).toBeVisible();
  expect(screen.getByText(devisId===12?"Replaced by":"Replaces")).not.toBeVisible();
  expect(screen.getByRole("button",{name:"Review previous work"})).not.toBeVisible();
  fireEvent.click(reveal);
  expect(screen.getByRole("link",{name:devisId===12?"NEW":"OLD"})).toHaveAttribute("href",`/projets/4?tab=devis&devis=${devisId===12?19:12}`);
  fireEvent.click(screen.getByText("Replacement details · actor, date & internal context"));
  expect(screen.getByText("Internal reason",{exact:false})).toBeVisible();
  fireEvent.click(reveal);
  expect(screen.getByText("Internal reason",{exact:false})).not.toBeVisible();
  fireEvent.click(reveal);
  fireEvent.click(screen.getByRole("button",{name:"Review previous work"}));
  expect(screen.getByText("Previous work dialog")).toBeVisible();
});
it("shows no history control for an unrelated quotation",()=>{
  const {container}=render(<QuotationReplacementHistory entries={entries} devisId={30} projectId="4" />);
  expect(container).toBeEmptyDOMElement();
});
