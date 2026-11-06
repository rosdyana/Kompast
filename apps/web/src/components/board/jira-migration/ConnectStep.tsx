import { useState } from "react";
import { Button } from "@kompast/ui/Button";
import { FormField, TextField } from "@kompast/ui/Input";
import type { SelectOption } from "@kompast/ui/SelectMenu";
import { useTranslation } from "@kompast/i18n";
import {
  checkJiraConnectionFn,
  createJiraMigrationFn,
  listJiraBoardsFn,
  updateJiraMigrationCredentialsFn,
  type getJiraMigrationFn,
} from "@/lib/server-fns/jira-migration";
import { OptionPicker, StepHeading, errorText } from "./shared";

export type JiraMigrationRow = NonNullable<Awaited<ReturnType<typeof getJiraMigrationFn>>["migration"]>;
type ConnectionInfo = Awaited<ReturnType<typeof checkJiraConnectionFn>>;
type JiraBoard = Awaited<ReturnType<typeof listJiraBoardsFn>>[number];

const TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";
const NO_BOARD = "none";

interface ConnectStepProps {
  projectId: string;
  /** The Kompast board the imported sprints and issues land on. */
  boardId: string;
  migration: JiraMigrationRow | null;
  onChanged: () => Promise<void>;
}

/**
 * Step 1. With no migration: site, email and token, a connection check, then
 * the JIRA project and board to import, and "Scan project". With a migration:
 * the connection summary, or (when its token was cleared or the user chooses
 * to change it) a credentials form that only replaces the email and token.
 */
export function ConnectStep({ projectId, boardId, migration, onChanged }: ConnectStepProps) {
  if (migration) return <ExistingConnection migration={migration} onChanged={onChanged} />;
  return <NewConnection projectId={projectId} boardId={boardId} onChanged={onChanged} />;
}

function ExistingConnection({ migration, onChanged }: { migration: JiraMigrationRow; onChanged: () => Promise<void> }) {
  const { t } = useTranslation("board");
  const [editing, setEditing] = useState(false);
  const showForm = !migration.hasToken || editing;
  return (
    <div>
      <StepHeading title={t("jiraMigration.connect.heading")} />
      {showForm ? (
        <CredentialsForm
          migration={migration}
          tokenOnly={!migration.hasToken}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
          onCancel={migration.hasToken ? () => setEditing(false) : undefined}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="type-small text-text-2">
            {t("jiraMigration.connect.currentConnection", { site: migration.siteUrl.replace(/^https:\/\//, ""), email: migration.email })}{" "}
            {t("jiraMigration.connect.jiraProjectLine", { key: migration.jiraProjectKey })}
          </p>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {t("jiraMigration.connect.changeConnection")}
          </Button>
        </div>
      )}
    </div>
  );
}

export function CredentialsForm({
  migration,
  tokenOnly,
  onSaved,
  onCancel,
}: {
  migration: JiraMigrationRow;
  tokenOnly: boolean;
  onSaved: () => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation("board");
  const [email, setEmail] = useState(migration.email);
  const [apiToken, setApiToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!apiToken.trim() || (!tokenOnly && !email.trim())) {
      setError(t("jiraMigration.connect.requiredHint"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateJiraMigrationCredentialsFn({ data: { migrationId: migration.id, apiToken: apiToken.trim(), ...(tokenOnly ? {} : { email: email.trim() }) } });
      setApiToken("");
      await onSaved();
    } catch (err) {
      setError(errorText(err, t("genericError")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="flex max-w-[520px] flex-col gap-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {tokenOnly && <p className="type-small text-text-2">{t("jiraMigration.connect.tokenOnlyLead")}</p>}
      {!tokenOnly && (
        <FormField label={t("jiraMigration.connect.emailLabel")} htmlFor="jm-email-edit" required>
          <TextField id="jm-email-edit" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormField>
      )}
      <TokenField id="jm-token-edit" value={apiToken} onChange={setApiToken} />
      {error && <p className="type-small text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? t("jiraMigration.working") : t("jiraMigration.connect.saveToken")}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
        )}
      </div>
    </form>
  );
}

function TokenField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation("board");
  return (
    <FormField
      label={t("jiraMigration.connect.apiTokenLabel")}
      htmlFor={id}
      required
      hint={
        <>
          {t("jiraMigration.connect.tokenHelp")}{" "}
          <a href={TOKEN_URL} target="_blank" rel="noreferrer" className="text-accent-text hover:underline">
            {TOKEN_URL.replace("https://", "")}
          </a>
        </>
      }
    >
      <TextField id={id} type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
    </FormField>
  );
}

function NewConnection({ projectId, boardId, onChanged }: { projectId: string; boardId: string; onChanged: () => Promise<void> }) {
  const { t } = useTranslation("board");
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [connection, setConnection] = useState<ConnectionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [boards, setBoards] = useState<JiraBoard[] | null>(null);
  const [jiraBoardId, setJiraBoardId] = useState<string>(NO_BOARD);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Editing the credentials makes the earlier check stale. */
  function edit(set: (v: string) => void) {
    return (v: string) => {
      set(v);
      setConnection(null);
      setProjectKey(null);
      setBoards(null);
    };
  }

  async function check() {
    if (!siteUrl.trim() || !email.trim() || !apiToken.trim()) {
      setError(t("jiraMigration.connect.requiredHint"));
      return;
    }
    setChecking(true);
    setError(null);
    try {
      setConnection(await checkJiraConnectionFn({ data: { projectId, siteUrl: siteUrl.trim(), email: email.trim(), apiToken: apiToken.trim() } }));
    } catch (err) {
      setError(errorText(err, t("genericError")));
    } finally {
      setChecking(false);
    }
  }

  async function pickProject(key: string) {
    setProjectKey(key);
    setBoards(null);
    setError(null);
    try {
      const found = await listJiraBoardsFn({ data: { projectId, siteUrl: siteUrl.trim(), email: email.trim(), apiToken: apiToken.trim(), projectKey: key } });
      setBoards(found);
      const scrum = found.find((b) => b.type === "scrum");
      setJiraBoardId(scrum ? String(scrum.id) : NO_BOARD);
    } catch (err) {
      setBoards([]);
      setError(errorText(err, t("genericError")));
    }
  }

  async function scan() {
    if (!projectKey) return;
    setScanning(true);
    setError(null);
    try {
      await createJiraMigrationFn({
        data: {
          projectId,
          boardId,
          siteUrl: siteUrl.trim(),
          email: email.trim(),
          apiToken: apiToken.trim(),
          jiraProjectKey: projectKey,
          jiraBoardId: jiraBoardId === NO_BOARD ? null : Number(jiraBoardId),
        },
      });
      setApiToken("");
      await onChanged();
    } catch (err) {
      setError(errorText(err, t("genericError")));
    } finally {
      setScanning(false);
    }
  }

  const projectOptions: SelectOption[] = (connection?.projects ?? []).map((p) => ({ value: p.key, label: p.name, hint: p.key }));
  const boardOptions: SelectOption[] = [
    { value: NO_BOARD, label: t("jiraMigration.connect.boardNone") },
    ...(boards ?? []).map((b) => ({ value: String(b.id), label: b.name, hint: b.type })),
  ];

  return (
    <div>
      <StepHeading title={t("jiraMigration.connect.heading")} description={t("jiraMigration.connect.subtitle")} />
      <div className="flex max-w-[620px] flex-col gap-3.5">
        <FormField label={t("jiraMigration.connect.siteUrlLabel")} htmlFor="jm-site" required>
          <TextField id="jm-site" type="url" value={siteUrl} onChange={(e) => edit(setSiteUrl)(e.target.value)} placeholder={t("jiraMigration.connect.siteUrlPlaceholder")} />
        </FormField>
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <FormField label={t("jiraMigration.connect.emailLabel")} htmlFor="jm-email" required>
            <TextField id="jm-email" type="email" autoComplete="off" value={email} onChange={(e) => edit(setEmail)(e.target.value)} />
          </FormField>
          <TokenField id="jm-token" value={apiToken} onChange={edit(setApiToken)} />
        </div>
        <div>
          <Button variant="outline" onClick={check} disabled={checking}>
            {checking ? t("jiraMigration.connect.checking") : t("jiraMigration.connect.checkButton")}
          </Button>
        </div>
      </div>

      {connection && (
        <div className="mt-5 flex max-w-[620px] flex-col gap-3.5 rounded-[10px] border border-border bg-surface-2 p-4">
          <p className="type-small text-green">{t("jiraMigration.connect.connectedAs", { name: connection.myself.displayName })}</p>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <FormField label={t("jiraMigration.connect.projectLabel")}>
              <OptionPicker
                ariaLabel={t("jiraMigration.connect.projectLabel")}
                value={projectKey}
                options={projectOptions}
                onChange={pickProject}
                placeholder={t("jiraMigration.connect.projectPlaceholder")}
                width={360}
              />
            </FormField>
            <FormField label={t("jiraMigration.connect.boardLabel")}>
              <OptionPicker
                ariaLabel={t("jiraMigration.connect.boardLabel")}
                value={projectKey ? jiraBoardId : null}
                options={boardOptions}
                onChange={setJiraBoardId}
                disabled={!projectKey || boards === null}
                placeholder={boards === null && projectKey ? t("jiraMigration.connect.boardLoading") : t("jiraMigration.connect.boardNone")}
                width={360}
              />
            </FormField>
          </div>
          <div>
            <Button variant="primary" onClick={scan} disabled={!projectKey || scanning || boards === null}>
              {scanning ? t("jiraMigration.connect.scanStarting") : t("jiraMigration.connect.scanButton")}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-4 max-w-[620px] rounded-[6px] bg-danger-soft px-3 py-2 type-small text-danger">{error}</p>}
    </div>
  );
}
