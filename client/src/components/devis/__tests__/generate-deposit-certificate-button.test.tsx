// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GenerateDepositCertificateButton } from "../GenerateDepositCertificateButton";

afterEach(cleanup);
function setup(onConfirm = vi.fn().mockResolvedValue({ id: 1 })) {
  const parentClick = vi.fn();
  render(<div onClick={parentClick}>
    <GenerateDepositCertificateButton devisId={49} quotation="FD.1.BAND · DE0000482"
      deposit="Acompte 30%" onConfirm={onConfirm} />
  </div>);
  fireEvent.click(screen.getByRole("button", { name: "Generate Certificate" }));
  return { onConfirm, parentClick };
}

describe("deposit certificate confirmation", () => {
  it("opens a confirmation without generating; Cancel does nothing", () => {
    const { onConfirm, parentClick } = setup();
    expect(screen.getByRole("alertdialog").textContent).toContain("FD.1.BAND · DE0000482");
    expect(screen.getByRole("alertdialog").textContent).toContain("Acompte 30%");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("generates only after explicit confirmation and blocks repeated clicks while pending", async () => {
    let resolve!: (value: unknown) => void;
    const onConfirm = vi.fn(() => new Promise(r => { resolve = r; }));
    setup(onConfirm);
    fireEvent.click(screen.getByRole("button", { name: "Yes, generate certificate" }));
    const pending = screen.getByRole("button", { name: "Generating…" }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);
    fireEvent.click(pending);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    resolve({});
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("keeps the dialog open with an error after a failed request", async () => {
    setup(vi.fn().mockRejectedValue(new Error("Certificate could not be generated")));
    fireEvent.click(screen.getByRole("button", { name: "Yes, generate certificate" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Certificate could not be generated");
    expect((screen.getByRole("button", { name: "Yes, generate certificate" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
