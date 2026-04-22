import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Contractor } from "@shared/schema";

interface ContractorSelectProps {
  contractors: Contractor[];
  value: number | null | undefined;
  onChange: (id: number) => void;
  disabled?: boolean;
  placeholder?: string;
  testId?: string;
  className?: string;
}

export function ContractorSelect({
  contractors,
  value,
  onChange,
  disabled = false,
  placeholder = "Select contractor",
  testId = "select-contractor",
  className = "text-[12px]",
}: ContractorSelectProps) {
  const selectable = (contractors ?? []).filter((c) => !c.archidocOrphanedAt || c.id === value);

  return (
    <Select
      value={value ? String(value) : ""}
      onValueChange={(v) => onChange(Number(v))}
      disabled={disabled}
    >
      <SelectTrigger className={className} data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {selectable.map((c) => (
          <SelectItem key={c.id} value={String(c.id)} data-testid={`${testId}-option-${c.id}`}>
            {c.name}
            {c.archidocOrphanedAt ? " (removed from ArchiDoc)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
