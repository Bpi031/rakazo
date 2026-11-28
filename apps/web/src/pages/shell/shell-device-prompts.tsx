import type { Me } from "@rakazo/contracts";
import type { Dispatch, SetStateAction } from "react";
import { ComputerUpdateProgress } from "../../components/computers/ComputerUpdateProgress";
import { HostComputerPrompt } from "./host-computer-prompt";
import { TimezonePrompt, withSavedTimezone } from "./timezone-prompt";

export function ShellDevicePrompts({
  me,
  userId,
  setMe,
  onComputerUpdated,
}: {
  me: Me | null | undefined;
  userId: string | undefined;
  setMe: Dispatch<SetStateAction<Me | null | undefined>>;
  onComputerUpdated: () => void;
}) {
  return (
    <>
      <ComputerUpdateProgress onCompleted={onComputerUpdated} />
      {me !== undefined && <HostComputerPrompt initialMe={me ?? undefined} onMeUpdated={setMe} />}
      {userId && me ? (
        <TimezonePrompt
          key={userId}
          userId={userId}
          timezone={me.timezone}
          onSaved={(saved, adopted) =>
            setMe((previous) => withSavedTimezone(previous, saved, adopted))
          }
        />
      ) : null}
    </>
  );
}
