#!/bin/sh
set -eu
# Register after other binfmt services so this tested emulator takes precedence.
binfmt=/proc/sys/fs/binfmt_misc
if [ ! -e "$binfmt/register" ]; then
  mount -t binfmt_misc binfmt_misc "$binfmt"
fi
if [ -e "$binfmt/spotify-cli-amd64" ]; then
  printf '%s\n' -1 > "$binfmt/spotify-cli-amd64"
fi
printf '%s\n' ':spotify-cli-amd64:M::\x7f\x45\x4c\x46\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00:\xff\xff\xff\xff\xff\xfe\xfe\xfc\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/usr/local/libexec/spotify-cli/qemu-x86_64:PF' > "$binfmt/register"
