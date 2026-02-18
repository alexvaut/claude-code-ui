interface VSCodeIconProps {
  size?: number;
  color?: string;
}

/** Classic VS Code brand blue */
export const VSCODE_BLUE = "#007ACC";

export function VSCodeIcon({ size = 14, color }: VSCodeIconProps) {
  const fill = color ?? "currentColor";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "block" }}
    >
      <mask id="vsc-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <path
          d="M70.9 99.3c1.9.8 4 .8 5.9-.1l17.9-8.6c3.1-1.5 5.1-4.6 5.1-8.1V17.5c0-3.4-2-6.5-5.1-8.1L76.8.8c-2.5-1.2-5.4-.9-7.5.7L26.8 38.6 11.2 27.1a4.7 4.7 0 0 0-6.1.3L.8 31.6a4.7 4.7 0 0 0 0 6.8L14.5 50 .8 61.6a4.7 4.7 0 0 0 0 6.8l4.3 4.2a4.7 4.7 0 0 0 6.1.3L26.8 61.4 69.3 98.5c.5.4 1 .6 1.6.8z"
          fill="white"
        />
      </mask>
      <g mask="url(#vsc-mask)">
        <path d="M94.7 9.4 76.8.8c-2.5-1.3-5.6-1-7.8.8L.8 61.6a4.7 4.7 0 0 0 0 6.8l4.3 4.2a4.7 4.7 0 0 0 6.1.3l78.1-60.7c4-3.1 9.7-.3 9.7 4.7v-.5c0-3.4-2-6.5-5.1-8.1l.8 1.1z" fill={fill} opacity=".7" />
        <path d="M76.8 99.2 94.7 90.6c3.1-1.5 5.1-4.7 5.1-8.1v.5c0 5-5.7 7.8-9.7 4.7l-78.1-60.7a4.7 4.7 0 0 1-6.1.3L1.6 23.1a4.7 4.7 0 0 1 0 6.8L69 98.5c2.2 1.8 5.3 2.1 7.8.8z" fill={fill} opacity=".5" />
        <path d="M76.8 99.2c-2.5 1.3-5.6 1-7.8-.8a5.3 5.3 0 0 0 7.8.8l17.9-8.6c3.1-1.5 5.1-4.7 5.1-8.1V17.5c0-3.4-2-6.5-5.1-8.1L76.8.8c-2.5-1.3-5.6-1-7.8.8.4-.3.8-.6 1.3-.8 2.5-1.3 5.6-1 7.8.8l16.6 8c3.1 1.5 5.1 4.6 5.1 8.1v65c0 3.4-2 6.6-5.1 8.1l-16.6 8.5-.3-.3z" fill={fill} opacity=".9" />
      </g>
    </svg>
  );
}
