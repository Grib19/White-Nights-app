import type { CSSProperties } from "react";

// Палитра из презентации «Белые Ночи»
export const colors = {
  navy: "#022342",
  blue: "#94C0D9",
  yellow: "#FFEAAB",
  white: "#FFFFFF",
  field: "#EEF5F9",
  gray: "#5F7385",
};

export const page: CSSProperties = {
  fontFamily: "Arial, Helvetica, sans-serif",
  maxWidth: 1100,
  margin: "0 auto",
  padding: 16,
  color: colors.white,
};
export const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: 12,
  margin: "4px 0 12px",
  fontSize: 16,
  color: colors.navy,
  background: colors.field,
  border: "none",
  borderRadius: 8,
};
export const button: CSSProperties = {
  width: "100%",
  padding: 12,
  fontSize: 16,
  fontWeight: 700,
  color: colors.navy,
  background: colors.yellow,
  border: "none",
  borderRadius: 10,
  cursor: "pointer",
};
export const card: CSSProperties = {
  color: "#f5f5f5",
  background: "#0b1420",
  borderRadius: 16,
  padding: 24,
  marginBottom: 12,
};
export const tabs: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 16,
};
export const tabButton = (active: boolean): CSSProperties => ({
  padding: "8px 14px",
  fontSize: 15,
  color: colors.navy,
  background: active ? colors.yellow : colors.blue,
  border: "none",
  borderRadius: 10,
  cursor: active ? "default" : "pointer",
  fontWeight: active ? 700 : 400,
});
