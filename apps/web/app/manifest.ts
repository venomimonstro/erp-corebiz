import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Business OS WMS",
    short_name: "WMS",
    description: "Scanner-first warehouse workspace",
    start_url: "/app/wms/mobile",
    display: "standalone",
    background_color: "#f5f6f7",
    theme_color: "#181a1d",
    orientation: "portrait",
    icons: [
      {
        src: "/wms-icon.svg",
        sizes: "any",
        type: "image/svg+xml"
      }
    ]
  };
}
