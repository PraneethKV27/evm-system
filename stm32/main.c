/**
 ******************************************************************************
 * @file    main.c
 * @brief   SecEVM STM32 Firmware
 *          - R307 Optical Fingerprint Sensor via USART1 (57600 baud)
 *          - Debug / PC bridge via USART2 (115200 baud)
 *          - Push buttons for voter Aadhaar digit entry
 *          - Green LED  → PA5  (match / enroll success)
 *          - Red LED    → PA6  (mismatch / error)
 *          - Buzzer     → PB0
 *          - BTN_CONFIRM→ PC13 (built-in blue button, active-low)
 *          - BTN_NEXT   → PB1  (cycle digit 0-9, active-low)
 *
 * UART messages sent to PC (picked up by fingerprint-server/server.js):
 *   ENROLL_OK:ID=<aadhaar>:SAMPLES=5
 *   MATCH_OK ID=<aadhaar>
 *   MATCH_FAIL ID=<aadhaar>
 *   VOTER_DATA:ID=<aadhaar>:NAME=<name>:AGE=<age>:PARTY=<party>
 *   STATUS:<message>
 *
 * PC sends commands back (read via USART2 RX):
 *   VOTER_INFO:<aadhaar>:<name>:<age>:<gender>
 *   ACK_VOTE:<aadhaar>:<party>
 ******************************************************************************
 */

#include "main.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

/* ─────────────────────────────────────────────────────────────
   UART handles
   ───────────────────────────────────────────────────────────── */
UART_HandleTypeDef huart1;   /* R307 fingerprint sensor  */
UART_HandleTypeDef huart2;   /* PC / debug bridge        */

/* ─────────────────────────────────────────────────────────────
   R307 Command Packets  (Adafruit / generic R307 protocol)
   ───────────────────────────────────────────────────────────── */

/* GenImg – capture image from sensor */
static const uint8_t CMD_GEN_IMG[]    = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                          0x01,0x00,0x03,0x01,0x00,0x05};
/* Img2Tz slot 1 – convert image → feature file in CharBuffer1 */
static const uint8_t CMD_IMG2TZ_1[]   = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                          0x01,0x00,0x04,0x02,0x01,0x00,0x08};
/* Img2Tz slot 2 – convert image → feature file in CharBuffer2 */
static const uint8_t CMD_IMG2TZ_2[]   = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                          0x01,0x00,0x04,0x02,0x02,0x00,0x09};
/* RegModel – combine CharBuffer1+2 into template */
static const uint8_t CMD_REG_MODEL[]  = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                          0x01,0x00,0x03,0x05,0x00,0x09};
/* Store template at page 1 (we use 1 fixed slot; extend as needed) */
static const uint8_t CMD_STORE[]      = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                          0x01,0x00,0x06,0x06,0x01,0x00,0x01,0x00,0x0F};
/* Search – match live image against all stored templates */
static const uint8_t CMD_SEARCH[]     = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                          0x01,0x00,0x08,0x04,0x01,0x00,0x00,0x00,0x0A,0x00,0x18};

/* ─────────────────────────────────────────────────────────────
   State machine
   ───────────────────────────────────────────────────────────── */
typedef enum {
    STATE_IDLE = 0,
    STATE_ENTER_AADHAAR,
    STATE_ENROLLING,
    STATE_VERIFY,
    STATE_DONE
} SystemState;

static SystemState sysState = STATE_IDLE;

/* Aadhaar being entered via push buttons */
#define AADHAAR_LEN 12
static char currentAadhaar[AADHAAR_LEN + 1] = {0};
static uint8_t aadhaarPos   = 0;
static uint8_t currentDigit = 0;   /* digit being cycled by BTN_NEXT */

/* PC→STM32 receive buffer */
#define RX_BUF_SIZE 128
static uint8_t  rxByte;
static char     rxLine[RX_BUF_SIZE];
static uint8_t  rxIdx = 0;
static uint8_t  rxLineReady = 0;

/* Stored voter info received from PC */
static char voterName[64]   = "";
static char voterAge[4]     = "";
static char voterGender[12] = "";
static char voterParty[8]   = "";

/* ─────────────────────────────────────────────────────────────
   Function prototypes
   ───────────────────────────────────────────────────────────── */
static void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_USART1_UART_Init(void);
static void MX_USART2_UART_Init(void);

static void R307_SendCommand(const uint8_t *cmd, uint16_t len);
static uint8_t R307_ReadResponse(uint8_t *buf, uint16_t len);
static uint8_t R307_WaitForFinger(void);
static uint8_t R307_CaptureAndConvert(uint8_t slot);
static uint8_t R307_Enroll(const char *aadhaar);
static uint8_t R307_Verify(const char *aadhaar);

static void Debug_Print(const char *msg);
static void Debug_Printf(const char *fmt, ...);
static void SendToPC(const char *msg);

static void LED_Green_On(void);
static void LED_Green_Off(void);
static void LED_Red_On(void);
static void LED_Red_Off(void);
static void Buzzer_Beep(void);
static void Buzzer_BeepLong(void);

static void Btn_WaitConfirm(void);
static uint8_t Btn_NextPressed(void);
static uint8_t Btn_ConfirmPressed(void);

static void EnterAadhaarMode(void);
static void ProcessRxLine(const char *line);

/* ─────────────────────────────────────────────────────────────
   MAIN
   ───────────────────────────────────────────────────────────── */
int main(void)
{
    HAL_Init();
    SystemClock_Config();
    MX_GPIO_Init();
    MX_USART1_UART_Init();
    MX_USART2_UART_Init();

    /* Start async receive for PC commands */
    HAL_UART_Receive_IT(&huart2, &rxByte, 1);

    Debug_Print("\r\n=== SecEVM STM32 Ready ===\r\n");
    Debug_Print("Press CONFIRM to start enrollment\r\n");
    SendToPC("STATUS:STM32 Ready");

    sysState = STATE_IDLE;

    while (1)
    {
        /* ── Process any complete line received from PC ── */
        if (rxLineReady) {
            rxLineReady = 0;
            ProcessRxLine(rxLine);
        }

        switch (sysState)
        {
            /* ─── IDLE ────────────────────────────────────── */
            case STATE_IDLE:
                if (Btn_ConfirmPressed()) {
                    HAL_Delay(50); /* debounce */
                    sysState = STATE_ENTER_AADHAAR;
                    EnterAadhaarMode();
                }
                break;

            /* ─── ENTER AADHAAR VIA BUTTONS ──────────────── */
            case STATE_ENTER_AADHAAR:
            {
                if (Btn_NextPressed()) {
                    HAL_Delay(50);
                    currentDigit = (currentDigit + 1) % 10;
                    char buf[32];
                    snprintf(buf, sizeof(buf),
                             "Digit[%d]=%d\r\n", aadhaarPos, currentDigit);
                    Debug_Print(buf);
                    HAL_Delay(200); /* short hold to prevent re-trigger */
                }

                if (Btn_ConfirmPressed()) {
                    HAL_Delay(50);
                    currentAadhaar[aadhaarPos] = '0' + currentDigit;
                    aadhaarPos++;
                    currentDigit = 0;

                    char buf[32];
                    snprintf(buf, sizeof(buf),
                             "Pos %d confirmed: %c\r\n",
                             aadhaarPos, currentAadhaar[aadhaarPos - 1]);
                    Debug_Print(buf);
                    Buzzer_Beep();

                    if (aadhaarPos == AADHAAR_LEN) {
                        currentAadhaar[AADHAAR_LEN] = '\0';
                        char msg[64];
                        snprintf(msg, sizeof(msg),
                                 "Aadhaar entered: %s\r\n", currentAadhaar);
                        Debug_Print(msg);

                        /* Ask PC for voter info */
                        char pcMsg[64];
                        snprintf(pcMsg, sizeof(pcMsg),
                                 "REQUEST_VOTER:%s", currentAadhaar);
                        SendToPC(pcMsg);

                        sysState = STATE_ENROLLING;
                        Debug_Print("Starting enrollment...\r\n");
                    }
                    HAL_Delay(300);
                }
                break;
            }

            /* ─── ENROLL 5 SAMPLES ────────────────────────── */
            case STATE_ENROLLING:
            {
                uint8_t result = R307_Enroll(currentAadhaar);
                if (result == 0) {
                    /* Success */
                    char pcMsg[64];
                    snprintf(pcMsg, sizeof(pcMsg),
                             "ENROLL_OK:ID=%s:SAMPLES=5", currentAadhaar);
                    SendToPC(pcMsg);
                    Debug_Print("Enrollment complete!\r\n");
                    Buzzer_Beep();
                    Buzzer_Beep();
                    LED_Green_On();
                    HAL_Delay(1000);
                    LED_Green_Off();
                } else {
                    SendToPC("STATUS:Enrollment failed");
                    Debug_Print("Enrollment failed.\r\n");
                    LED_Red_On();
                    HAL_Delay(1000);
                    LED_Red_Off();
                }
                sysState = STATE_IDLE;
                Debug_Print("Press CONFIRM to verify\r\n");
                break;
            }

            /* ─── VERIFY (triggered by PC or second button press) ── */
            case STATE_VERIFY:
            {
                Debug_Print("Starting verification...\r\n");
                uint8_t result = R307_Verify(currentAadhaar);
                if (result == 0) {
                    char pcMsg[64];
                    snprintf(pcMsg, sizeof(pcMsg),
                             "MATCH_OK ID=%s", currentAadhaar);
                    SendToPC(pcMsg);
                    Debug_Print("MATCH OK\r\n");
                    LED_Green_On();
                    Buzzer_Beep();
                    HAL_Delay(1000);
                    LED_Green_Off();
                } else {
                    char pcMsg[64];
                    snprintf(pcMsg, sizeof(pcMsg),
                             "MATCH_FAIL ID=%s", currentAadhaar);
                    SendToPC(pcMsg);
                    Debug_Print("MATCH FAIL\r\n");
                    LED_Red_On();
                    Buzzer_BeepLong();
                    HAL_Delay(1000);
                    LED_Red_Off();
                }
                sysState = STATE_IDLE;
                break;
            }

            default:
                sysState = STATE_IDLE;
                break;
        }
    }
}

/* ─────────────────────────────────────────────────────────────
   ProcessRxLine — handle commands sent from the PC bridge
   ───────────────────────────────────────────────────────────── */
static void ProcessRxLine(const char *line)
{
    Debug_Print("[PC] ");
    Debug_Print(line);
    Debug_Print("\r\n");

    /* VOTER_INFO:<aadhaar>:<name>:<age>:<gender>
       Received after we sent REQUEST_VOTER — store locally and echo back */
    if (strncmp(line, "VOTER_INFO:", 11) == 0) {
        char buf[128];
        strncpy(buf, line + 11, sizeof(buf) - 1);

        /* Parse colon-separated fields */
        char *token = strtok(buf, ":");
        if (token) strncpy(currentAadhaar, token, AADHAAR_LEN);
        token = strtok(NULL, ":");
        if (token) strncpy(voterName,   token, sizeof(voterName)   - 1);
        token = strtok(NULL, ":");
        if (token) strncpy(voterAge,    token, sizeof(voterAge)    - 1);
        token = strtok(NULL, ":");
        if (token) strncpy(voterGender, token, sizeof(voterGender) - 1);

        char msg[128];
        snprintf(msg, sizeof(msg),
                 "Voter: %s, Age: %s\r\n", voterName, voterAge);
        Debug_Print(msg);

        /* Forward full voter data back to PC for Firestore */
        char pcMsg[200];
        snprintf(pcMsg, sizeof(pcMsg),
                 "VOTER_DATA:ID=%s:NAME=%s:AGE=%s:GENDER=%s",
                 currentAadhaar, voterName, voterAge, voterGender);
        SendToPC(pcMsg);
    }

    /* ACK_VOTE:<aadhaar>:<party>
       PC confirmed vote was recorded in Firestore */
    else if (strncmp(line, "ACK_VOTE:", 9) == 0) {
        char buf[64];
        strncpy(buf, line + 9, sizeof(buf) - 1);
        char *aadhaar_tok = strtok(buf, ":");
        char *party_tok   = strtok(NULL, ":");
        if (aadhaar_tok) strncpy(currentAadhaar, aadhaar_tok, AADHAAR_LEN);
        if (party_tok)   strncpy(voterParty, party_tok, sizeof(voterParty) - 1);

        char msg[64];
        snprintf(msg, sizeof(msg),
                 "Vote confirmed: %s → %s\r\n", currentAadhaar, voterParty);
        Debug_Print(msg);

        LED_Green_On();
        Buzzer_Beep();
        HAL_Delay(500);
        LED_Green_Off();
    }

    /* CMD_VERIFY:<aadhaar>  — PC asks STM32 to do a live verify */
    else if (strncmp(line, "CMD_VERIFY:", 11) == 0) {
        strncpy(currentAadhaar, line + 11, AADHAAR_LEN);
        currentAadhaar[AADHAAR_LEN] = '\0';
        sysState = STATE_VERIFY;
    }

    /* CMD_ENROLL:<aadhaar>  — PC asks STM32 to enroll */
    else if (strncmp(line, "CMD_ENROLL:", 11) == 0) {
        strncpy(currentAadhaar, line + 11, AADHAAR_LEN);
        currentAadhaar[AADHAAR_LEN] = '\0';
        sysState = STATE_ENROLLING;
    }
}

/* ─────────────────────────────────────────────────────────────
   R307 Low-level helpers
   ───────────────────────────────────────────────────────────── */
static void R307_SendCommand(const uint8_t *cmd, uint16_t len)
{
    HAL_UART_Transmit(&huart1, (uint8_t *)cmd, len, HAL_MAX_DELAY);
}

static uint8_t R307_ReadResponse(uint8_t *buf, uint16_t len)
{
    HAL_StatusTypeDef status =
        HAL_UART_Receive(&huart1, buf, len, 2000); /* 2 s timeout */
    if (status != HAL_OK) return 0xFF; /* timeout/error */
    return buf[9]; /* confirmation code byte */
}

/* Wait until sensor detects a finger (GenImg returns 0x00) */
static uint8_t R307_WaitForFinger(void)
{
    uint8_t resp[12];
    uint8_t attempts = 0;
    while (attempts < 30) { /* ~6 s max */
        R307_SendCommand(CMD_GEN_IMG, sizeof(CMD_GEN_IMG));
        uint8_t code = R307_ReadResponse(resp, sizeof(resp));
        if (code == 0x00) return 0x00; /* finger detected and image captured */
        HAL_Delay(200);
        attempts++;
    }
    return 0x02; /* timeout — no finger */
}

/* Capture image and convert to feature file in given slot (1 or 2) */
static uint8_t R307_CaptureAndConvert(uint8_t slot)
{
    uint8_t resp[12];

    /* Step 1: get image */
    if (R307_WaitForFinger() != 0x00) return 0x02;

    /* Step 2: convert to feature */
    if (slot == 1) {
        R307_SendCommand(CMD_IMG2TZ_1, sizeof(CMD_IMG2TZ_1));
    } else {
        R307_SendCommand(CMD_IMG2TZ_2, sizeof(CMD_IMG2TZ_2));
    }
    return R307_ReadResponse(resp, sizeof(resp));
}

/* ─────────────────────────────────────────────────────────────
   R307_Enroll — full 5-sample enrollment
   Returns 0 on success, non-zero on failure.
   ───────────────────────────────────────────────────────────── */
static uint8_t R307_Enroll(const char *aadhaar)
{
    uint8_t resp[12];
    (void)aadhaar; /* used for debug/logging only */

    for (int sample = 1; sample <= 5; sample++) {
        char msg[48];
        snprintf(msg, sizeof(msg), "Sample %d/5 — place finger\r\n", sample);
        Debug_Print(msg);
        Buzzer_Beep();

        /* Capture into slot 1 */
        uint8_t code = R307_CaptureAndConvert(1);
        if (code != 0x00) {
            Debug_Print("Capture failed\r\n");
            LED_Red_On(); HAL_Delay(300); LED_Red_Off();
            sample--; /* retry */
            if (sample < 0) sample = 0;
            HAL_Delay(1000);
            continue;
        }

        Debug_Print("Remove finger\r\n");
        LED_Green_On(); HAL_Delay(500); LED_Green_Off();
        HAL_Delay(1500); /* wait for removal */

        /* For the last sample, also capture slot 2 to build template */
        if (sample == 5) {
            Debug_Print("Place finger again for final template\r\n");
            Buzzer_Beep();
            code = R307_CaptureAndConvert(2);
            if (code != 0x00) {
                Debug_Print("Second capture failed\r\n");
                return code;
            }

            /* Combine into template */
            R307_SendCommand(CMD_REG_MODEL, sizeof(CMD_REG_MODEL));
            code = R307_ReadResponse(resp, sizeof(resp));
            if (code != 0x00) {
                Debug_Print("Template creation failed\r\n");
                return code;
            }

            /* Store at page 1 */
            R307_SendCommand(CMD_STORE, sizeof(CMD_STORE));
            code = R307_ReadResponse(resp, sizeof(resp));
            if (code != 0x00) {
                Debug_Print("Store failed\r\n");
                return code;
            }
        }
    }
    return 0x00; /* success */
}

/* ─────────────────────────────────────────────────────────────
   R307_Verify — live fingerprint match against stored template
   Returns 0 on match, non-zero on fail/no-match.
   ───────────────────────────────────────────────────────────── */
static uint8_t R307_Verify(const char *aadhaar)
{
    uint8_t resp[16];
    (void)aadhaar;

    Debug_Print("Place finger to verify\r\n");
    uint8_t code = R307_CaptureAndConvert(1);
    if (code != 0x00) {
        Debug_Print("Capture failed for verify\r\n");
        return code;
    }

    R307_SendCommand(CMD_SEARCH, sizeof(CMD_SEARCH));
    /* Search response is 16 bytes; confirmation at byte 9 */
    HAL_UART_Receive(&huart1, resp, sizeof(resp), 2000);
    return resp[9]; /* 0x00 = found, 0x09 = not found */
}

/* ─────────────────────────────────────────────────────────────
   Aadhaar entry init
   ───────────────────────────────────────────────────────────── */
static void EnterAadhaarMode(void)
{
    memset(currentAadhaar, 0, sizeof(currentAadhaar));
    aadhaarPos   = 0;
    currentDigit = 0;
    Debug_Print("Enter 12-digit Aadhaar (NEXT=cycle, CONFIRM=select)\r\n");
}

/* ─────────────────────────────────────────────────────────────
   Button helpers  (active-low with internal pull-up)
   ───────────────────────────────────────────────────────────── */
static uint8_t Btn_ConfirmPressed(void)
{
    return (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_13) == GPIO_PIN_RESET);
}

static uint8_t Btn_NextPressed(void)
{
    return (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_1) == GPIO_PIN_RESET);
}

static void Btn_WaitConfirm(void)
{
    while (!Btn_ConfirmPressed()) { HAL_Delay(10); }
    HAL_Delay(50); /* debounce */
    while (Btn_ConfirmPressed()) { HAL_Delay(10); }  /* wait release */
}

/* ─────────────────────────────────────────────────────────────
   LED & Buzzer
   ───────────────────────────────────────────────────────────── */
static void LED_Green_On(void)  { HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_SET);   }
static void LED_Green_Off(void) { HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_RESET); }
static void LED_Red_On(void)    { HAL_GPIO_WritePin(GPIOA, GPIO_PIN_6, GPIO_PIN_SET);   }
static void LED_Red_Off(void)   { HAL_GPIO_WritePin(GPIOA, GPIO_PIN_6, GPIO_PIN_RESET); }

static void Buzzer_Beep(void) {
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_SET);
    HAL_Delay(150);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_RESET);
    HAL_Delay(50);
}

static void Buzzer_BeepLong(void) {
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_SET);
    HAL_Delay(600);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_RESET);
}

/* ─────────────────────────────────────────────────────────────
   UART helpers
   ───────────────────────────────────────────────────────────── */
static void Debug_Print(const char *msg)
{
    HAL_UART_Transmit(&huart2, (uint8_t *)msg, (uint16_t)strlen(msg), HAL_MAX_DELAY);
}

#include <stdarg.h>
static void Debug_Printf(const char *fmt, ...)
{
    char buf[128];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    Debug_Print(buf);
}

/* Send a structured message to PC (fingerprint-server reads this) */
static void SendToPC(const char *msg)
{
    HAL_UART_Transmit(&huart2, (uint8_t *)msg,  (uint16_t)strlen(msg),  HAL_MAX_DELAY);
    HAL_UART_Transmit(&huart2, (uint8_t *)"\n", 1, HAL_MAX_DELAY);
}

/* ─────────────────────────────────────────────────────────────
   UART2 RX interrupt callback — accumulate lines from PC
   ───────────────────────────────────────────────────────────── */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
    if (huart->Instance == USART2) {
        if (rxByte == '\n' || rxByte == '\r') {
            if (rxIdx > 0) {
                rxLine[rxIdx] = '\0';
                rxIdx = 0;
                rxLineReady = 1;
            }
        } else {
            if (rxIdx < RX_BUF_SIZE - 1) {
                rxLine[rxIdx++] = (char)rxByte;
            }
        }
        HAL_UART_Receive_IT(&huart2, &rxByte, 1);
    }
}

/* ─────────────────────────────────────────────────────────────
   Peripheral Init
   ───────────────────────────────────────────────────────────── */

/* USART1 — R307 fingerprint sensor @ 57600 */
static void MX_USART1_UART_Init(void)
{
    huart1.Instance        = USART1;
    huart1.Init.BaudRate   = 57600;
    huart1.Init.WordLength = UART_WORDLENGTH_8B;
    huart1.Init.StopBits   = UART_STOPBITS_1;
    huart1.Init.Parity     = UART_PARITY_NONE;
    huart1.Init.Mode       = UART_MODE_TX_RX;
    huart1.Init.HwFlowCtl  = UART_HWCONTROL_NONE;
    huart1.Init.OverSampling = UART_OVERSAMPLING_16;
    HAL_UART_Init(&huart1);
}

/* USART2 — PC debug/bridge @ 115200 */
static void MX_USART2_UART_Init(void)
{
    huart2.Instance        = USART2;
    huart2.Init.BaudRate   = 115200;
    huart2.Init.WordLength = UART_WORDLENGTH_8B;
    huart2.Init.StopBits   = UART_STOPBITS_1;
    huart2.Init.Parity     = UART_PARITY_NONE;
    huart2.Init.Mode       = UART_MODE_TX_RX;
    huart2.Init.HwFlowCtl  = UART_HWCONTROL_NONE;
    huart2.Init.OverSampling = UART_OVERSAMPLING_16;
    HAL_UART_Init(&huart2);
}

/* GPIO init */
static void MX_GPIO_Init(void)
{
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_GPIOC_CLK_ENABLE();

    GPIO_InitTypeDef GPIO_InitStruct = {0};

    /* ── Outputs ── */
    /* Green LED PA5, Red LED PA6 */
    GPIO_InitStruct.Pin   = GPIO_PIN_5 | GPIO_PIN_6;
    GPIO_InitStruct.Mode  = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull  = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

    /* Buzzer PB0 */
    GPIO_InitStruct.Pin   = GPIO_PIN_0;
    GPIO_InitStruct.Mode  = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull  = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

    /* ── Inputs ── */
    /* BTN_NEXT PB1 — active low */
    GPIO_InitStruct.Pin   = GPIO_PIN_1;
    GPIO_InitStruct.Mode  = GPIO_MODE_INPUT;
    GPIO_InitStruct.Pull  = GPIO_PULLUP;
    HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

    /* BTN_CONFIRM PC13 — built-in blue button, active low */
    GPIO_InitStruct.Pin   = GPIO_PIN_13;
    GPIO_InitStruct.Mode  = GPIO_MODE_INPUT;
    GPIO_InitStruct.Pull  = GPIO_NOPULL; /* blue button has external pull-up */
    HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);

    /* Initial output states — all off */
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5 | GPIO_PIN_6, GPIO_PIN_RESET);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_RESET);
}

/* Minimal clock config — 84 MHz HSI on STM32F4
   Replace with CubeMX-generated version for your exact MCU */
static void SystemClock_Config(void)
{
    RCC_OscInitTypeDef RCC_OscInitStruct = {0};
    RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

    RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
    RCC_OscInitStruct.HSIState       = RCC_HSI_ON;
    RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
    RCC_OscInitStruct.PLL.PLLState   = RCC_PLL_ON;
    RCC_OscInitStruct.PLL.PLLSource  = RCC_PLLSOURCE_HSI;
    RCC_OscInitStruct.PLL.PLLM       = 8;
    RCC_OscInitStruct.PLL.PLLN       = 84;
    RCC_OscInitStruct.PLL.PLLP       = RCC_PLLP_DIV2;
    RCC_OscInitStruct.PLL.PLLQ       = 4;
    HAL_RCC_OscConfig(&RCC_OscInitStruct);

    RCC_ClkInitStruct.ClockType      = RCC_CLOCKTYPE_HCLK  | RCC_CLOCKTYPE_SYSCLK |
                                       RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    RCC_ClkInitStruct.SYSCLKSource   = RCC_SYSCLKSOURCE_PLLCLK;
    RCC_ClkInitStruct.AHBCLKDivider  = RCC_SYSCLK_DIV1;
    RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV4;
    RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV2;
    HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_2);
}

void Error_Handler(void)
{
    LED_Red_On();
    while (1) { HAL_Delay(500); }
}
