import type { ComponentProps, ReactNode } from "react";
import { PageLoading } from "../../components/PageLoading";
import { PagesProvider } from "../../lib/pages/pages";
import { SpaceRpcProvider } from "../../lib/query/space-rpc";
import { InboundOriginProvider } from "../../lib/routines/inbound-url";

export function ShellSpaceContent({
  spaceId,
  ready,
  inboundOrigin,
  pages,
  children,
}: {
  spaceId: ComponentProps<typeof SpaceRpcProvider>["spaceId"];
  ready: boolean;
  inboundOrigin: ComponentProps<typeof InboundOriginProvider>["value"];
  pages: ComponentProps<typeof PagesProvider>["value"];
  children: ReactNode;
}) {
  return (
    <SpaceRpcProvider spaceId={spaceId}>
      {ready ? (
        <InboundOriginProvider value={inboundOrigin}>
          <PagesProvider value={pages}>{children}</PagesProvider>
        </InboundOriginProvider>
      ) : (
        <PageLoading />
      )}
    </SpaceRpcProvider>
  );
}
