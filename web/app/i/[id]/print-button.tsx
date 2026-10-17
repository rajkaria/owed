"use client";

import { PrinterIcon } from "./printer-icon";

/** Opens the browser's print dialog; "Save as PDF" there gives a one-page PDF of the invoice. */
export function PrintButton({ className = "" }: { className?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className={className}>
      <PrinterIcon className="shrink-0" width={18} height={18} />
      Print or save as PDF
    </button>
  );
}
