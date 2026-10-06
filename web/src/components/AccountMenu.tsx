import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CaretDown, Copy, Check, SignOut, SquaresFour } from "@phosphor-icons/react";
import { short } from "../lib/chain.ts";
import { CONFIG } from "../lib/config.ts";
import { navigate } from "../lib/router.ts";
import type { Wallet } from "../lib/wallet.ts";

/** The connected account in the top bar: opens a menu with the address, the dashboard, and Disconnect. */
export function AccountMenu({ wallet }: { wallet: Wallet }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const address = wallet.address!;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    addEventListener("pointerdown", onDown);
    addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    return () => {
      removeEventListener("pointerdown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Arrow keys move between items, as a menu should.
  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  }

  return (
    <div className="account" ref={root}>
      <button
        ref={button}
        type="button"
        className="account-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="account"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`account-dot ${wallet.wrongNetwork ? "account-dot-bad" : ""}`} aria-hidden />
        <span className="mono">{short(address)}</span>
        <CaretDown weight="bold" className="account-caret" aria-hidden />
      </button>
      {open && (
        <div className="account-menu" role="menu" aria-label="Account" onKeyDown={onMenuKey}>
          <div className="account-head">
            <span className="label">{wallet.wrongNetwork ? `Connected, on chain ${wallet.chainId}` : "Connected to X Layer"}</span>
            <span className="mono account-addr">{address}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="account-item"
            onClick={async () => {
              await navigator.clipboard.writeText(address);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check weight="bold" /> : <Copy weight="bold" />} {copied ? "Copied" : "Copy address"}
          </button>
          <a role="menuitem" className="account-item" href={`${CONFIG.explorer}/address/${address}`} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
            <ArrowUpRight weight="bold" /> View on OKLink
          </a>
          <button
            type="button"
            role="menuitem"
            className="account-item"
            onClick={() => {
              setOpen(false);
              navigate("/app");
            }}
          >
            <SquaresFour weight="bold" /> Dashboard
          </button>
          <div className="account-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="account-item account-danger"
            data-testid="disconnect"
            onClick={() => {
              setOpen(false);
              void wallet.disconnect();
              navigate("/");
            }}
          >
            <SignOut weight="bold" /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
