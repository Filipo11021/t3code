import { useState } from "react";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";

export function RetentionControl({
  label,
  value,
  onChange,
  minimum = 1,
  maximum = 3650,
  unit = "days",
  enabledValue = 8,
  disabled = false,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  minimum?: number;
  maximum?: number;
  unit?: "days" | "minutes";
  enabledValue?: number;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }
  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <NumberField
          value={draft}
          min={minimum}
          max={maximum}
          step={1}
          size="sm"
          className="w-auto"
          disabled={disabled}
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) setDraft(value);
            else {
              const bounded = Math.min(maximum, Math.max(minimum, Math.round(next)));
              setDraft(bounded);
              onChange(bounded);
            }
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`Decrease ${label}`} />
            <NumberFieldInput
              aria-label={`${label} in ${unit}`}
              size={5}
              className="w-auto grow-0 text-right"
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              {unit}
            </span>
            <NumberFieldIncrement aria-label={`Increase ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">Off</span>
      )}
      <Switch
        aria-label={label}
        checked={value !== null}
        disabled={disabled}
        onCheckedChange={(enabled) => onChange(enabled ? enabledValue : null)}
      />
    </div>
  );
}
