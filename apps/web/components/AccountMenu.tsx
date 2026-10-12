"use client";
import { useEffect, useState, type ComponentType } from "react";
export function AccountMenu() {
  const [Content, setContent] = useState<ComponentType | null>(null);
  useEffect(() => {
    let active = true;
    void import("./AccountMenuContent").then((module) => {
      if (active) setContent(() => module.default);
    });
    return () => {
      active = false;
    };
  }, []);
  return Content ? <Content /> : null;
}
