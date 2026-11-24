import { ContextMenu as Primitive } from "@base-ui/react/context-menu";
import { cn } from "@rakazo/ui-web/lib/utils";

export const ContextMenu = Primitive.Root;
export const ContextMenuTrigger = Primitive.Trigger;

export function ContextMenuContent({ className, ...props }: Primitive.Popup.Props) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner className="isolate z-50 outline-none">
        <Primitive.Popup
          data-slot="context-menu-content"
          className={cn(
            "w-56 max-w-(--available-width) max-h-(--available-height) overflow-auto rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none",
            className,
          )}
          {...props}
        />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
