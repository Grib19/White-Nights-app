import type { CSSProperties } from "react";

export const page: CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 520,
  margin: "0 auto",
  padding: 16,
};
export const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: 10,
  margin: "4px 0 12px",
  fontSize: 16,
};
export const button: CSSProperties = {
  width: "100%",
  padding: 12,
  fontSize: 16,
  cursor: "pointer",
};
export const card: CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
};
export const tabs: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginBottom: 16,
};
