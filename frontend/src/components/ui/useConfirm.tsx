// Promise-based confirm hook. Place <ConfirmProvider> once near the
// app root; any descendant can call `const confirm = useConfirm();`
// and `await confirm({...})` to get a styled boolean prompt.

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { ConfirmDialog, type ConfirmOptions } from "./ConfirmDialog";

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn | null>(null);

type Pending = {
  opts: ConfirmOptions;
  resolve: (v: boolean) => void;
};

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      setPending({ opts, resolve });
    });
  }, []);

  const settle = (result: boolean) => {
    if (pending) pending.resolve(result);
    setPending(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title={pending?.opts.title ?? ""}
        message={pending?.opts.message ?? ""}
        confirmLabel={pending?.opts.confirmLabel}
        cancelLabel={pending?.opts.cancelLabel}
        tone={pending?.opts.tone}
        icon={pending?.opts.icon}
        onConfirm={() => settle(true)}
        onCancel={() => settle(false)}
      />
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const fn = useContext(Ctx);
  if (!fn) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return fn;
}
