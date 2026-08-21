import {useEffect, useRef} from "react";

type ConfirmDialogProps = {
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "default" | "warning" | "danger";
    onConfirm: () => void;
    onCancel: () => void;
};

export function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel = "继续",
    cancelLabel = "取消",
    tone = "default",
    onConfirm,
    onCancel,
}: ConfirmDialogProps) {
    const confirmRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        confirmRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") onCancel();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [open, onCancel]);

    if (!open) return null;
    const confirmClass = tone === "danger"
        ? "bg-red-600 hover:bg-red-700"
        : tone === "warning"
            ? "bg-amber-600 hover:bg-amber-700"
            : "bg-blue-600 hover:bg-blue-700";

    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
            <div className="w-full max-w-md overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
                <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-4">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600" aria-hidden="true">!</span>
                    <div className="min-w-0">
                        <h3 id="confirm-dialog-title" className="text-base font-semibold text-gray-900">{title}</h3>
                        <p className="mt-1 whitespace-pre-line text-sm leading-6 text-gray-600">{message}</p>
                    </div>
                </div>
                <div className="flex justify-end gap-2 bg-gray-50 px-5 py-3">
                    <button type="button" onClick={onCancel} className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100">{cancelLabel}</button>
                    <button ref={confirmRef} type="button" onClick={onConfirm} className={`rounded-md px-3 py-1.5 text-sm font-medium text-white ${confirmClass}`}>{confirmLabel}</button>
                </div>
            </div>
        </div>
    );
}
