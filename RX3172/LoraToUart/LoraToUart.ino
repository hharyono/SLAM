double myFreq = 	923.2 * 1000000;
uint16_t sf = 7, bw =2, cr = 1, preamble = 8, txPower = 14;

#define SEND_INTERVAL 10  // milliseconds
#define MAX_BUF 32

uint8_t txBuf[MAX_BUF];
uint8_t txLen = 0;
unsigned long lastSendTime = 0;

void sendMessageViaLora(uint8_t *data, uint8_t len) {
    // Echo to UART
    // for (uint8_t i = 0; i < len; i++) {
    //     Serial.write(data[i]);
    // }

    // Send via LoRa
    api.lora.precv(0);          // Stop receiving
    delay(10);
    api.lora.psend(len, data);  // Transmit
    delay(100);
    api.lora.precv(65534);      // Resume receiving
}

void setup() {
    Serial.begin(19200, RAK_CUSTOM_MODE); // UART
    delay(200);
    Serial.print("START...");
    initLora();
    delay(200);
    Serial.print("DONE...");
}

void initLora() {
    if (api.lora.nwm.get() != 0) {
        api.lora.nwm.set();
        api.system.reboot();
    }

    api.lora.pfreq.set(myFreq);
    api.lora.psf.set(sf);
    api.lora.pbw.set(bw);
    api.lora.pcr.set(cr);
    api.lora.ppl.set(preamble);
    api.lora.ptp.set(txPower);

    api.lora.precv(65534);  // Start receiving
    api.lora.registerPRecvCallback(onLoraReceived);
}

void onLoraReceived(rui_lora_p2p_recv_t data) {
    if (data.Buffer && data.BufferSize > 0) {
        for (int i = 0; i < data.BufferSize; i++) {
            Serial.write(data.Buffer[i]);  // Forward to UART
        }
    }
}

void loop() {
    unsigned long now = millis();

    // Read available bytes and store in buffer
    while (Serial.available() > 0 && txLen < MAX_BUF) {
        txBuf[txLen++] = Serial.read();
    }

    // Send if timeout or buffer full
    if (txLen > 0 && (now - lastSendTime >= SEND_INTERVAL || txLen == MAX_BUF)) {
        sendMessageViaLora(txBuf, txLen);
        txLen = 0;
        lastSendTime = now;
    }
}
