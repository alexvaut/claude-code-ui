import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/router-devtools";
import { Theme, Box, Heading, Flex, Text } from "@radix-ui/themes";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <Theme
      accentColor="violet"
      grayColor="slate"
      radius="large"
      scaling="100%"
      appearance="dark"
    >
      <Box px="5" py="5" style={{ maxWidth: "1800px", margin: "0 auto" }}>
        <Flex direction="column" gap="5">
          <Flex align="baseline" gap="3">
            <Heading size="8" weight="bold">
              Sessions
            </Heading>
            <Text size="3" color="violet">
              Claude Code
            </Text>
          </Flex>
          <Outlet />
        </Flex>
      </Box>
      <TanStackRouterDevtools />
    </Theme>
  );
}
