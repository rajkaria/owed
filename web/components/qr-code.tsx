import QRCode from "qrcode";

/**
 * Server-rendered QR code as inline SVG: no extra request, no layout shift,
 * and it works on /p where there is no stored request to point an image at.
 * The SVG comes from the qrcode library; the URL is encoded as modules, never
 * inserted as markup.
 */
export async function QrCode({ value, label }: { value: string; label: string }) {
  const svg = await QRCode.toString(value, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 0,
    color: { dark: "#000000", light: "#ffffff" },
  });
  const sized = svg.replace(/\s(width|height)="[^"]*"/g, "").replace("<svg ", '<svg width="100%" height="100%" ');
  return (
    <div
      role="img"
      aria-label={label}
      className="aspect-square w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
      dangerouslySetInnerHTML={{ __html: sized }}
    />
  );
}
