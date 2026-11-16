import { Trans, useLingui } from "@lingui/react/macro";
import type { CallDoctor } from "@rakazo/contracts";
import { callDoctorInput } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogTitle, Input, Label, Switch } from "@rakazo/ui-web";
import { ArrowLeft, Download, Pencil, Plus, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { CallDoctorDetails } from "./call-doctor-import";
import { CallDoctorImportError, parseCallDoctorCsv } from "./call-doctor-import";

export function CallDoctorDirectory({
  open,
  onOpenChange,
  doctors,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doctors: CallDoctor[];
  onSave: (doctors: CallDoctorDetails[]) => Promise<void>;
}) {
  const { t } = useLingui();
  const id = useId();
  const [editing, setEditing] = useState<CallDoctor | "new" | null>(null);
  const [preview, setPreview] = useState<CallDoctorDetails[] | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const readGeneration = useRef(0);
  useEffect(() => {
    if (open) return;
    readGeneration.current++;
    setEditing(null);
    setPreview(null);
    setError("");
    setReading(false);
  }, [open]);

  function back() {
    setEditing(null);
    setPreview(null);
    setError("");
  }

  async function save(rows: CallDoctorDetails[]) {
    setSaving(true);
    setError("");
    try {
      await onSave(rows);
      back();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t`Could not save doctors. Try again.`);
    } finally {
      setSaving(false);
    }
  }

  async function importFile(file: File) {
    const generation = ++readGeneration.current;
    setReading(true);
    setError("");
    try {
      if (file.size > 512 * 1024) throw new CallDoctorImportError("large");
      const rows = parseCallDoctorCsv(await file.text());
      if (generation !== readGeneration.current) return;
      const existing = new Map(doctors.map((doctor) => [doctor.code, doctor]));
      for (const row of rows) {
        if (doctors.some((doctor) => doctor.email === row.email && doctor.code !== row.code))
          throw new CallDoctorImportError("duplicates");
      }
      // Updating contact details must not silently reactivate a disabled doctor.
      setPreview(rows.map((row) => ({ ...row, active: existing.get(row.code)?.active ?? true })));
    } catch (reason) {
      if (generation !== readGeneration.current) return;
      if (reason instanceof CallDoctorImportError) {
        if (reason.kind === "columns")
          setError(t`Use a CSV with Staff ID, Name and Email columns.`);
        else if (reason.kind === "empty") setError(t`This file has no doctors.`);
        else if (reason.kind === "large")
          setError(t`Choose a CSV with up to 1,000 doctors, under 512 KB.`);
        else if (reason.kind === "duplicates")
          setError(t`Each doctor needs a unique Staff ID and email.`);
        else setError(t`Check the doctor details on row ${reason.row}.`);
      } else setError(t`Could not read this file. Choose a CSV.`);
    } finally {
      if (generation === readGeneration.current) setReading(false);
    }
  }

  const busy = saving || reading;
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent
        className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-lg"
        aria-describedby={undefined}
      >
        <div className="flex min-h-6 items-center gap-2 pr-8">
          {(editing || preview) && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Back to doctors`}
              disabled={busy}
              onClick={back}
            >
              <ArrowLeft size={16} />
            </Button>
          )}
          <DialogTitle>
            {editing === "new" ? (
              <Trans>Add doctor</Trans>
            ) : editing ? (
              <Trans>Edit doctor</Trans>
            ) : preview ? (
              <Trans>Import doctors</Trans>
            ) : (
              <Trans>Doctors</Trans>
            )}
          </DialogTitle>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {editing ? (
          <DoctorForm
            key={editing === "new" ? "new" : editing.id}
            doctor={editing === "new" ? undefined : editing}
            busy={saving}
            onCancel={back}
            onSave={async (doctor) => {
              if (
                doctors.some(
                  (existing) => existing.email === doctor.email && existing.code !== doctor.code,
                ) ||
                (editing === "new" && doctors.some((existing) => existing.code === doctor.code))
              ) {
                setError(t`Each doctor needs a unique Staff ID and email.`);
                return;
              }
              await save([doctor]);
            }}
          />
        ) : preview ? (
          <>
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">
                      <Trans>Name</Trans>
                    </th>
                    <th className="pb-2 font-medium">
                      <Trans>Email</Trans>
                    </th>
                    <th className="pb-2 font-medium">
                      <Trans>Staff ID</Trans>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((doctor) => (
                    <tr key={doctor.code} className="border-t border-border">
                      <td className="py-3 pr-3">
                        {doctor.name}
                        {doctors.some((existing) => existing.code === doctor.code) && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            <Trans>Update</Trans>
                          </span>
                        )}
                      </td>
                      <td className="max-w-52 break-all py-3 pr-3">{doctor.email}</td>
                      <td className="py-3">{doctor.code}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={back}>
                <Trans>Cancel</Trans>
              </Button>
              <Button disabled={busy} onClick={() => void save(preview)}>
                <Trans>Import doctors</Trans>
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload size={15} />
                  <Trans>Import CSV</Trans>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  nativeButton={false}
                  render={
                    <a href="/templates/call-doctors.csv" download="call-doctors-template.csv" />
                  }
                >
                  <Download size={14} />
                  <Trans>Template</Trans>
                </Button>
              </div>
              <Button
                disabled={busy}
                onClick={() => {
                  setError("");
                  setEditing("new");
                }}
              >
                <Plus size={15} />
                <Trans>Add doctor</Trans>
              </Button>
            </div>
            <input
              ref={fileInput}
              id={`${id}-import`}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              tabIndex={-1}
              aria-label={t`Import doctor CSV`}
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importFile(file);
              }}
            />
            <div className="max-h-80 overflow-y-auto">
              {doctors.length ? (
                <ul className="divide-y divide-border">
                  {doctors.map((doctor) => (
                    <li key={doctor.id} className="flex items-center gap-3 py-3">
                      <div
                        className={`min-w-0 flex-1 ${doctor.active ? "" : "text-muted-foreground"}`}
                      >
                        <p className="break-words font-medium">{doctor.name}</p>
                        <p className="break-all text-xs text-muted-foreground">{doctor.email}</p>
                        {!doctor.active && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            <Trans>Disabled</Trans>
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Edit ${doctor.name}`}
                        disabled={busy}
                        onClick={() => {
                          setError("");
                          setEditing(doctor);
                        }}
                      >
                        <Pencil size={15} />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  <Trans>No doctors added.</Trans>
                </p>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DoctorForm({
  doctor,
  busy,
  onSave,
  onCancel,
}: {
  doctor?: CallDoctor;
  busy: boolean;
  onSave: (doctor: CallDoctorDetails) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [name, setName] = useState(doctor?.name ?? "");
  const [email, setEmail] = useState(doctor?.email ?? "");
  const [code, setCode] = useState(doctor?.code ?? "");
  const [active, setActive] = useState(doctor?.active ?? true);
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = callDoctorInput.safeParse({ name, email: email.trim(), code, active });
        if (!result.success) {
          setError(t`Check the name, email and Staff ID.`);
          return;
        }
        setError("");
        void onSave(result.data);
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={`${id}-name`}>
            <Trans>Name</Trans>
          </Label>
          <Input
            id={`${id}-name`}
            autoComplete="off"
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-email`}>
            <Trans>Email</Trans>
          </Label>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="off"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${id}-code`}>
            <Trans>Staff ID</Trans>
          </Label>
          <Input
            id={`${id}-code`}
            autoComplete="off"
            required
            pattern="[A-Za-z0-9_.-]+"
            maxLength={80}
            readOnly={Boolean(doctor)}
            value={code}
            onChange={(event) => {
              if (!doctor) setCode(event.target.value);
            }}
          />
        </div>
        {doctor && (
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${id}-enabled`}>
              <Trans>Enabled</Trans>
            </Label>
            <Switch id={`${id}-enabled`} checked={active} onCheckedChange={setActive} />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit">
            <Trans>Save</Trans>
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
