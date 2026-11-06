import { useState } from "react";
import { ContainerSetup } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { Button } from "../../components/ui/button";

const decodeSetup = Schema.decodeUnknownSync(ContainerSetup);
const decodeEnvironment = Schema.decodeUnknownSync(
  Schema.fromJsonString(ContainerSetup.fields.environment),
);

export function ContainerEnvironmentSetup({
  title,
  initial,
  disabled,
  onSave,
  saveLabel = "Save project environment",
}: {
  title: string;
  initial: ContainerSetup;
  disabled: boolean;
  onSave: (value: ContainerSetup) => Promise<void>;
  saveLabel?: string;
}) {
  const [image, setImage] = useState(initial.image);
  const [installScript, setInstallScript] = useState(initial.installScript);
  const [startScript, setStartScript] = useState(initial.startScript);
  const [environment, setEnvironment] = useState(JSON.stringify(initial.environment, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <h3 className="font-medium">{title}</h3>
      <p className="text-sm text-muted-foreground">
        Source files are shared with the host. New containers use this project's saved environment.
        Existing containers keep their setup snapshot.
      </p>
      <label className="grid gap-2 text-sm">
        Base image
        <Input
          aria-label="Container image"
          value={image}
          onChange={(event) => setImage(event.target.value)}
          disabled={disabled}
        />
      </label>
      <label className="grid gap-2 text-sm">
        Install script
        <Textarea
          aria-label="Container install script"
          rows={3}
          value={installScript}
          onChange={(event) => setInstallScript(event.target.value)}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          Runs once after success. Recreating a removed runtime installs again; retries may repeat
          partial work.
        </span>
      </label>
      <label className="grid gap-2 text-sm">
        Start script
        <Textarea
          aria-label="Container start script"
          rows={3}
          value={startScript}
          onChange={(event) => setStartScript(event.target.value)}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          Must finish before T3 is ready on each start. Use a guest terminal for long-running
          commands.
        </span>
      </label>
      <label className="grid gap-2 text-sm">
        Plain environment values as JSON
        <Textarea
          aria-label="Container environment variables"
          rows={2}
          value={environment}
          onChange={(event) => setEnvironment(event.target.value)}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          Non-secret values only. Host credentials are not copied, and core guest settings cannot be
          overridden.
        </span>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        disabled={disabled}
        onClick={() => {
          void (async () => {
            try {
              await onSave(
                decodeSetup({
                  image,
                  installScript,
                  startScript,
                  environment: decodeEnvironment(environment),
                }),
              );
              setError(null);
            } catch (cause) {
              setError(
                cause instanceof Error ? cause.message : "Container setup could not be saved.",
              );
            }
          })();
        }}
      >
        {saveLabel}
      </Button>
    </div>
  );
}
