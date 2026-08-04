import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./styles.css";

export const metadata: Metadata = {
  title: "Pactmark governed agent console",
  description: "Deterministic, ephemeral Pactmark Next.js reference host.",
};

export default function RootLayout(props: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{props.children}</body>
    </html>
  );
}
