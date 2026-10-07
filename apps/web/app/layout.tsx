import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Business OS",
  description: "Управляйте бизнесом, а не программой."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
