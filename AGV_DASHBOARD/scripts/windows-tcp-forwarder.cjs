const net = require('node:net');
const os = require('node:os');

const boardAddress = process.argv[2];
const ports = process.argv.slice(3).map(Number).filter(Number.isInteger);

if (!boardAddress || ports.length === 0) {
  console.error('usage: windows-tcp-forwarder.cjs BOARD_ADDRESS PORT...');
  process.exit(2);
}

const boardSubnet = boardAddress.split('.').slice(0, 3).join('.');
const listenAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((address) =>
    address &&
    address.family === 'IPv4' &&
    !address.internal &&
    address.address.startsWith(`${boardSubnet}.`),
  )?.address;

if (!listenAddress) {
  console.error(`No Windows IPv4 address found in ${boardSubnet}.0/24`);
  process.exit(3);
}

for (const port of ports) {
  const server = net.createServer((incoming) => {
    const outgoing = net.connect({ host: '127.0.0.1', port });
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
    const closeBoth = () => {
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.on('error', closeBoth);
    outgoing.on('error', closeBoth);
  });

  server.on('error', (error) => {
    if (error.code !== 'EADDRINUSE') console.error(`${listenAddress}:${port}: ${error.message}`);
  });
  server.listen(port, listenAddress, () => {
    console.log(`Forwarding ${listenAddress}:${port} -> 127.0.0.1:${port}`);
  });
}

