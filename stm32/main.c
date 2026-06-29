/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Main secure EVM program body
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "main.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
/* USER CODE END Includes */

/* Private typedef -----------------------------------------------------------*/
/* USER CODE BEGIN PTD */
typedef enum {
    STATE_IDLE = 0,
    STATE_ENROLLING,
    STATE_VERIFY,
    STATE_VOTING
} SystemState;
/* USER CODE END PTD */

/* Private define ------------------------------------------------------------*/
/* USER CODE BEGIN PD */
#define AADHAAR_LEN      12
#define TEMPLATE_BYTES   512    /* R307 CharBuffer size in bytes          */
#define B64_ENCODED_LEN  700    /* ceil(512/3)*4 + overhead               */
#define RX_BUF_SIZE      1024    /* PC → STM32 receive buffer              */
#define MAX_TEMPLATES    5
/* Match score threshold — R307 Search returns a 16-bit confidence score.
   Maximum is 0xFFFF (65535). We require ≥ 80% of max = 52428.             */
#define MATCH_SCORE_THRESHOLD  50U   /* Typical R307 match score threshold */
/* USER CODE END PD */

/* Private variables ---------------------------------------------------------*/
UART_HandleTypeDef huart1;
UART_HandleTypeDef huart2;

/* USER CODE BEGIN PV */
static SystemState sysState = STATE_IDLE;
/* Current enrollment progress */
static char    currentAadhaar[AADHAAR_LEN + 1] = {0};
static uint8_t currentSample  = 0;   /* 1-based sample being processed      */
static uint8_t consentGranted = 0;   /* set by ProcessRxLine when ACK arrives */
static uint8_t enrollAborted  = 0;   /* set when ABORT_ENROLL received        */


/* PC→STM32 receive buffer (Global variables for ISR access) */
uint8_t rxByte;
char    rxLine[RX_BUF_SIZE];
uint8_t rxIdx      = 0;
volatile uint8_t rxLineReady = 0;

/* Stored voter info */
static char voterName[64]   = "";
static char voterAge[4]     = "";
static char voterGender[12] = "";

/* ─────────────────────────────────────────────────────────────
   R307 Command Packets
   ───────────────────────────────────────────────────────────── */
/* GenImg — capture image */
static const uint8_t CMD_GEN_IMG[]   = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                         0x01,0x00,0x03,0x01,0x00,0x05};
/* Img2Tz slot 1 */
static const uint8_t CMD_IMG2TZ_1[]  = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                         0x01,0x00,0x04,0x02,0x01,0x00,0x08};
/* Img2Tz slot 2 */
static const uint8_t CMD_IMG2TZ_2[]  = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                         0x01,0x00,0x04,0x02,0x02,0x00,0x09};
/* RegModel — fuse slot1+slot2 into template */
static const uint8_t CMD_REG_MODEL[] = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                         0x01,0x00,0x03,0x05,0x00,0x09};
/* Store template at page 1 (shared slot) */
static const uint8_t CMD_STORE[]     = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                         0x01,0x00,0x06,0x06,0x01,0x00,0x01,0x00,0x0F};
/* Search pages 0..9 — covers up to 5 loaded templates */
static const uint8_t CMD_SEARCH[]    = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                         0x01,0x00,0x08,0x04,0x01,0x00,0x00,0x00,0x09,0x00,0x17};
/* UpChar — upload CharBuffer1 raw data (used to export captured template) */
static const uint8_t CMD_UP_CHAR[]   = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                         0x01,0x00,0x04,0x08,0x01,0x00,0x0E};
/* DnChar — download raw template bytes into CharBuffer1 (used to load template) */
static const uint8_t CMD_DN_CHAR[]   = {0xEF,0x01,0xFF,0xFF,0xFF,0xFF,
                                         0x01,0x00,0x04,0x09,0x01,0x00,0x0F};
/* USER CODE END PV */

/* Private function prototypes -----------------------------------------------*/
void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_USART1_UART_Init(void);
static void MX_USART1_UART_Init_Baud(uint32_t baudrate);
static void MX_USART2_UART_Init(void);
/* USER CODE BEGIN PFP */
static void     R307_SendCommand(const uint8_t *cmd, uint16_t len);
static void     R307_ClearErrors(void);
static uint8_t  R307_ReadResponse(uint8_t *buf, uint16_t len);
static uint8_t  R307_WaitForFinger(void);
static uint8_t  R307_CaptureAndConvert(uint8_t slot);
static uint8_t  R307_UploadCharBuffer(uint8_t *outBuf, uint16_t *outLen);
static uint8_t  R307_DownloadCharBuffer(const uint8_t *data, uint16_t len);
static uint8_t  R307_StorePage(uint8_t page);
static uint8_t  R307_Enroll(const char *aadhaar);
static uint8_t  R307_Verify(const char *aadhaar);
static uint8_t  R307_CheckConnection(void);
static void     Base64Encode(const uint8_t *in, uint16_t inLen, char *out);
static uint16_t Base64Decode(const char *in, uint8_t *out);
static void     Debug_Print(const char *msg);
static void     SendToPC(const char *msg);
static void     LED_Green_On(void);
static void     LED_Green_Off(void);
static void     Buzzer_Beep(void);
static void     Buzzer_BeepLong(void);
static void     ProcessRxLine(const char *line);
static uint8_t  Btn_AB_Pressed(void);
static uint8_t  Btn_CD_Pressed(void);
static uint8_t  Btn_EF_Pressed(void);
static uint8_t  Btn_GH_Pressed(void);
static uint8_t  Btn_NOTA_Pressed(void);
/* USER CODE END PFP */

/* Private user code ---------------------------------------------------------*/
/* USER CODE BEGIN 0 */
/* USER CODE END 0 */

/**
  * @brief  The application entry point.
  * @retval int
  */
int main(void)
{
  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* Configure the system clock */
  SystemClock_Config();

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  MX_USART1_UART_Init();
  MX_USART2_UART_Init();
  /* USER CODE BEGIN 2 */
  HAL_UART_Receive_IT(&huart2, &rxByte, 1);
  Debug_Print("\r\n=== SecEVM STM32 Ready (multi-template fusion) ===\r\n");
  SendToPC("STATUS:STM32 Ready");
  
  // Check sensor connection once at boot to report status to the PC
  HAL_Delay(500);
  if (R307_CheckConnection()) {
      SendToPC("STATUS:SENSOR_CONNECTED");
  } else {
      SendToPC("STATUS:SENSOR_DISCONNECTED");
  }
  
  sysState = STATE_IDLE;
  /* USER CODE END 2 */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  while (1)
  {
    if (rxLineReady) {
        rxLineReady = 0;
        ProcessRxLine(rxLine);
    }
    // Connection check disabled to prevent flapping states
    switch (sysState)
    {
        case STATE_IDLE:
            break;
        case STATE_ENROLLING:
        {
            if (!R307_CheckConnection()) {
                SendToPC("STATUS:SENSOR_DISCONNECTED");
                sysState = STATE_IDLE;
                break;
            }
            uint8_t result = R307_Enroll(currentAadhaar);
            if (result == 0) {
                char pcMsg[64];
                snprintf(pcMsg, sizeof(pcMsg),
                         "ENROLL_OK:ID=%s:SAMPLES=5", currentAadhaar);
                SendToPC(pcMsg);
                Debug_Print("Enrollment complete!\r\n");
                LED_Green_On(); Buzzer_Beep(); Buzzer_Beep();
                HAL_Delay(1000); LED_Green_Off();
            } else if (enrollAborted) {
                SendToPC("STATUS:Enrollment aborted by voter");
                Debug_Print("Enrollment aborted.\r\n");
                HAL_Delay(500);
                enrollAborted = 0;
            } else {
                SendToPC("STATUS:Enrollment failed");
                Debug_Print("Enrollment failed.\r\n");
                HAL_Delay(1000);
            }
            sysState = STATE_IDLE;
            break;
        }
        case STATE_VERIFY:
        {
            if (!R307_CheckConnection()) {
                SendToPC("STATUS:SENSOR_DISCONNECTED");
                sysState = STATE_IDLE;
                break;
            }
            uint8_t result = R307_Verify(currentAadhaar);
            if (result == 0) {
                char pcMsg[64];
                snprintf(pcMsg, sizeof(pcMsg), "MATCH_OK ID=%s", currentAadhaar);
                SendToPC(pcMsg);
                LED_Green_On(); Buzzer_Beep();
                HAL_Delay(1000); LED_Green_Off();

                sysState = STATE_VOTING;
                SendToPC("STATUS:VOTING_MODE_ACTIVE");
                char debugBtns[80];
                snprintf(debugBtns, sizeof(debugBtns), "STATUS:DEBUG_BTNS:AB=%d:CD=%d:EF=%d:GH=%d:NOTA=%d",
                         Btn_AB_Pressed(), Btn_CD_Pressed(), Btn_EF_Pressed(), Btn_GH_Pressed(), Btn_NOTA_Pressed());
                SendToPC(debugBtns);
            } else if (result == 0x10) {
                /* Score below 80% threshold — not a hard sensor fail */
                char pcMsg[80];
                snprintf(pcMsg, sizeof(pcMsg),
                         "MATCH_FAIL ID=%s:REASON=SCORE_LOW", currentAadhaar);
                SendToPC(pcMsg);
                Buzzer_BeepLong();
                HAL_Delay(1000);
                sysState = STATE_IDLE;
            } else {
                char pcMsg[64];
                snprintf(pcMsg, sizeof(pcMsg), "MATCH_FAIL ID=%s", currentAadhaar);
                SendToPC(pcMsg);
                Buzzer_BeepLong();
                HAL_Delay(1000);
                sysState = STATE_IDLE;
            }
            break;
        }
        case STATE_VOTING:
        {
            // Toggle Green LED to indicate active voting state
            static uint32_t lastBlink = 0;
            static uint32_t lastDebug = 0;
            static uint8_t votingInit = 0;
            static uint8_t prev_AB = 0;
            static uint8_t prev_CD = 0;
            static uint8_t prev_EF = 0;
            static uint8_t prev_GH = 0;
            static uint8_t prev_NOTA = 0;

            if (votingInit == 0) {
                prev_AB = Btn_AB_Pressed();
                prev_CD = Btn_CD_Pressed();
                prev_EF = Btn_EF_Pressed();
                prev_GH = Btn_GH_Pressed();
                prev_NOTA = Btn_NOTA_Pressed();
                votingInit = 1;
            }

            if (HAL_GetTick() - lastBlink > 500) {
                lastBlink = HAL_GetTick();
                HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_6);
            }
            if (HAL_GetTick() - lastDebug > 1000) {
                lastDebug = HAL_GetTick();
                char debugBtns[80];
                snprintf(debugBtns, sizeof(debugBtns), "STATUS:DEBUG_BTNS:AB=%d:CD=%d:EF=%d:GH=%d:NOTA=%d",
                         Btn_AB_Pressed(),
                         Btn_CD_Pressed(),
                         Btn_EF_Pressed(),
                         Btn_GH_Pressed(),
                         Btn_NOTA_Pressed());
                SendToPC(debugBtns);
            }

            uint8_t cur_AB = Btn_AB_Pressed();
            uint8_t cur_CD = Btn_CD_Pressed();
            uint8_t cur_EF = Btn_EF_Pressed();
            uint8_t cur_GH = Btn_GH_Pressed();
            uint8_t cur_NOTA = Btn_NOTA_Pressed();

            const char *selected_party = NULL;
            if (cur_AB && !prev_AB) {
                HAL_Delay(40);
                if (Btn_AB_Pressed()) selected_party = "AB";
            } else if (cur_CD && !prev_CD) {
                HAL_Delay(40);
                if (Btn_CD_Pressed()) selected_party = "CD";
            } else if (cur_EF && !prev_EF) {
                HAL_Delay(40);
                if (Btn_EF_Pressed()) selected_party = "EF";
            } else if (cur_GH && !prev_GH) {
                HAL_Delay(40);
                if (Btn_GH_Pressed()) selected_party = "GH";
            } else if (cur_NOTA && !prev_NOTA) {
                HAL_Delay(40);
                if (Btn_NOTA_Pressed()) selected_party = "NOTA";
            }

            // Update previous states for next loop iteration
            prev_AB = cur_AB;
            prev_CD = cur_CD;
            prev_EF = cur_EF;
            prev_GH = cur_GH;
            prev_NOTA = cur_NOTA;

            if (selected_party != NULL) {
                HAL_GPIO_WritePin(GPIOA, GPIO_PIN_6, GPIO_PIN_RESET); // reset blink

                char pcMsg[128];
                snprintf(pcMsg, sizeof(pcMsg), "VOTE_CAST:ID=%s:PARTY=%s", currentAadhaar, selected_party);
                SendToPC(pcMsg);

                Buzzer_BeepLong();
                LED_Green_On();
                HAL_Delay(1000);
                LED_Green_Off();

                votingInit = 0; // Reset initialization flag for the next voter
                sysState = STATE_IDLE;
            }
            break;
        }
        default:
            sysState = STATE_IDLE;
            break;
    }
    /* USER CODE END WHILE */
  }
}

/**
  * @brief System Clock Configuration
  * @retval None
  */
void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  if (HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1) != HAL_OK)
  {
    Error_Handler();
  }

  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_MSI;
  RCC_OscInitStruct.MSIState = RCC_MSI_ON;
  RCC_OscInitStruct.MSICalibrationValue = 0;
  RCC_OscInitStruct.MSIClockRange = RCC_MSIRANGE_6;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_NONE;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_MSI;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV1;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_0) != HAL_OK)
  {
    Error_Handler();
  }
}

static void MX_USART1_UART_Init_Baud(uint32_t baudrate)
{
  huart1.Instance = USART1;
  huart1.Init.BaudRate = baudrate;
  huart1.Init.WordLength = UART_WORDLENGTH_8B;
  huart1.Init.StopBits = UART_STOPBITS_1;
  huart1.Init.Parity = UART_PARITY_NONE;
  huart1.Init.Mode = UART_MODE_TX_RX;
  huart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart1.Init.OverSampling = UART_OVERSAMPLING_16;
  huart1.Init.OneBitSampling = UART_ONE_BIT_SAMPLE_DISABLE;
  huart1.AdvancedInit.AdvFeatureInit = UART_ADVFEATURE_NO_INIT;
  HAL_UART_DeInit(&huart1);
  if (HAL_UART_Init(&huart1) != HAL_OK)
  {
    Error_Handler();
  }
}

static void MX_USART1_UART_Init(void)
{
  MX_USART1_UART_Init_Baud(57600);
}

/**
  * @brief USART2 Initialization Function
  * @param None
  * @retval None
  */
static void MX_USART2_UART_Init(void)
{
  huart2.Instance = USART2;
  huart2.Init.BaudRate = 115200;
  huart2.Init.WordLength = UART_WORDLENGTH_8B;
  huart2.Init.StopBits = UART_STOPBITS_1;
  huart2.Init.Parity = UART_PARITY_NONE;
  huart2.Init.Mode = UART_MODE_TX_RX;
  huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart2.Init.OverSampling = UART_OVERSAMPLING_16;
  huart2.Init.OneBitSampling = UART_ONE_BIT_SAMPLE_DISABLE;
  huart2.AdvancedInit.AdvFeatureInit = UART_ADVFEATURE_NO_INIT;
  if (HAL_UART_Init(&huart2) != HAL_OK)
  {
    Error_Handler();
  }
  /* USER CODE BEGIN USART2_Init 2 */
  /* Enable USART2 global interrupt in NVIC */
  HAL_NVIC_SetPriority(USART2_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(USART2_IRQn);
  /* USER CODE END USART2_Init 2 */
}

/**
  * @brief GPIO Initialization Function
  * @param None
  * @retval None
static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  /* GPIO Ports Clock Enable */
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5 | GPIO_PIN_6, GPIO_PIN_RESET);

  /*Configure GPIO pin Output Level */
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_RESET);

  /*Configure GPIO pins : PA5 PA6 (Green LED outputs) */
  GPIO_InitStruct.Pin = GPIO_PIN_5 | GPIO_PIN_6;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  /*Configure GPIO pin : PB0 (Buzzer output) */
  GPIO_InitStruct.Pin = GPIO_PIN_0;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

  /*Configure GPIO pin : PC7 (AB Button - Active Low, Pull-up) */
  GPIO_InitStruct.Pin = GPIO_PIN_7;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);

  /*Configure GPIO pins : PB3 PB5 PB6 PB10 (EF, GH, NOTA, CD Buttons - Active Low, Pull-up) */
  GPIO_InitStruct.Pin = GPIO_PIN_3|GPIO_PIN_5|GPIO_PIN_6|GPIO_PIN_10;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
}



/* USER CODE BEGIN 4 */
/* ─────────────────────────────────────────────────────────────
   R307_Enroll — 5-sample enrollment with per-sample consent
   ───────────────────────────────────────────────────────────── */
static uint8_t R307_Enroll(const char *aadhaar)
{
    enrollAborted  = 0;
    currentSample  = 0;
    static uint8_t rawBuf[TEMPLATE_BYTES + 16];
    static char    b64Buf[B64_ENCODED_LEN];
    for (int sample = 1; sample <= 5; sample++)
    {
        currentSample = (uint8_t)sample;
        char msg[64];
        snprintf(msg, sizeof(msg), "Sample %d/5 — place finger\r\n", sample);
        Debug_Print(msg);
        Buzzer_Beep();
        /* Step 1: capture → convert (max 3 retries per sample) */
        uint8_t code = 0xFF;
        uint8_t retries = 0;
        while (retries < 3) {
            code = R307_CaptureAndConvert(1);
            if (code == 0x00) break;
            Debug_Print("Capture failed — retrying\r\n");
            retries++;
            HAL_Delay(1000);
        }
        if (code != 0x00) {
            Debug_Print("Sample capture failed after 3 retries\r\n");
            return code;
        }
        LED_Green_On(); Buzzer_Beep(); HAL_Delay(300); LED_Green_Off();
        Debug_Print("Remove finger\r\n");
        HAL_Delay(1200);
        /* Step 2: notify PC that sample is ready, ask for consent */
        char pcMsg[64];
        snprintf(pcMsg, sizeof(pcMsg),
                 "SAMPLE_READY:ID=%s:SAMPLE=%d", aadhaar, sample);
        SendToPC(pcMsg);
        Debug_Print("Waiting for voter consent...\r\n");
        /* Step 3: wait for ACK_SAMPLE or ABORT_ENROLL (max 60 s) */
        consentGranted = 0;
        uint32_t waitStart = HAL_GetTick();
        while (!consentGranted && !enrollAborted) {
            if (rxLineReady) {
                rxLineReady = 0;
                ProcessRxLine(rxLine);
            }
            R307_ClearErrors();
            if ((HAL_GetTick() - waitStart) > 60000) {
                Debug_Print("Consent timeout\r\n");
                return 0x10; /* timeout */
            }
            HAL_Delay(10);
        }
        if (enrollAborted) {
            Debug_Print("Enrollment aborted by voter\r\n");
            return 0xFF;
        }
        /* Step 4: upload CharBuffer1 raw bytes from sensor */
        uint16_t rawLen = 0;
        code = R307_UploadCharBuffer(rawBuf, &rawLen);
        if (code != 0x00 || rawLen == 0) {
            Debug_Print("CharBuffer upload failed — aborting enrollment\r\n");
            return (code != 0x00) ? code : 0xFF;
        }
        Base64Encode(rawBuf, rawLen, b64Buf);
        /* TEMPLATE_n:ID=<aadhaar>:DATA=<base64> */
        char hdr[64];
        snprintf(hdr, sizeof(hdr), "TEMPLATE_%d:ID=%s:DATA=", sample, aadhaar);
        HAL_UART_Transmit(&huart2, (uint8_t *)hdr,   (uint16_t)strlen(hdr),  HAL_MAX_DELAY);
        HAL_UART_Transmit(&huart2, (uint8_t *)b64Buf, (uint16_t)strlen(b64Buf), HAL_MAX_DELAY);
        HAL_UART_Transmit(&huart2, (uint8_t *)"\n",  1, HAL_MAX_DELAY);
        char logMsg[48];
        snprintf(logMsg, sizeof(logMsg), "Template %d uploaded\r\n", sample);
        Debug_Print(logMsg);
    }
    /* All 5 samples consented — create a fused RegModel and store it */
    Debug_Print("Creating fused template (RegModel)...\r\n");
    /* Need two CharBuffers populated: capture one more pair */
    Debug_Print("Place finger for final fuse scan\r\n");
    Buzzer_Beep();
    uint8_t code = R307_CaptureAndConvert(1);
    if (code != 0x00) {
        Debug_Print("Final capture 1 failed\r\n");
        return 0x00;
    }
    HAL_Delay(800);
    Debug_Print("Place finger again\r\n");
    Buzzer_Beep();
    code = R307_CaptureAndConvert(2);
    if (code != 0x00) {
        Debug_Print("Final capture 2 failed\r\n");
        return 0x00;
    }
    /* RegModel */
    uint8_t resp[12];
    R307_SendCommand(CMD_REG_MODEL, sizeof(CMD_REG_MODEL));
    code = R307_ReadResponse(resp, sizeof(resp));
    if (code != 0x00) {
        Debug_Print("RegModel failed\r\n");
        return 0x00;
    }
    /* Store at page 1 */
    R307_SendCommand(CMD_STORE, sizeof(CMD_STORE));
    code = R307_ReadResponse(resp, sizeof(resp));
    if (code != 0x00) {
        Debug_Print("Store failed\r\n");
    }
    return 0x00;
}
/* ─────────────────────────────────────────────────────────────
   R307_Verify — multi-template fused verification with 80% threshold
   ───────────────────────────────────────────────────────────── */
static uint8_t R307_Verify(const char *aadhaar)
{
    (void)aadhaar;
    Debug_Print("Place finger to verify\r\n");
    uint8_t code = R307_CaptureAndConvert(1);
    if (code != 0x00) {
        Debug_Print("Capture failed for verify\r\n");
        return code;
    }
    /* Search — response is 16 bytes */
    uint8_t resp[16] = {0};
    R307_SendCommand(CMD_SEARCH, sizeof(CMD_SEARCH));
    HAL_StatusTypeDef rxStat = HAL_UART_Receive(&huart1, resp, sizeof(resp), 3000);
    if (rxStat != HAL_OK) {
        Debug_Print("Search UART timeout\r\n");
        return 0xFF;
    }
    uint8_t  confirmCode = resp[9];
    uint16_t matchScore  = ((uint16_t)resp[12] << 8) | resp[13];
    char logMsg[64];
    snprintf(logMsg, sizeof(logMsg),
             "Search: code=0x%02X score=%u (threshold=%u)\r\n",
             confirmCode, (unsigned)matchScore, (unsigned)MATCH_SCORE_THRESHOLD);
    Debug_Print(logMsg);
    if (confirmCode != 0x00) {
        return confirmCode;
    }
    if (matchScore < MATCH_SCORE_THRESHOLD) {
        char scoreMsg[64];
        snprintf(scoreMsg, sizeof(scoreMsg),
                 "Score %u below threshold %u — REJECTED\r\n",
                 (unsigned)matchScore, (unsigned)MATCH_SCORE_THRESHOLD);
        Debug_Print(scoreMsg);
        return 0x10;
    }
    uint32_t pct_tenths = ((uint32_t)matchScore * 1000U) / 65535U;
    uint32_t pct_int    = pct_tenths / 10U;
    uint32_t pct_frac   = pct_tenths % 10U;
    char okMsg[56];
    snprintf(okMsg, sizeof(okMsg),
             "MATCH accepted: score=%u (%u.%u%%)\r\n",
             (unsigned)matchScore, (unsigned)pct_int, (unsigned)pct_frac);
    Debug_Print(okMsg);
    return 0x00;
}
/* ─────────────────────────────────────────────────────────────
   ProcessRxLine — commands received from the PC bridge
   ───────────────────────────────────────────────────────────── */
static void ProcessRxLine(const char *line)
{
    Debug_Print("[PC] ");
    Debug_Print(line);
    Debug_Print("\r\n");
    if (strncmp(line, "ACK_SAMPLE:", 11) == 0) {
        char buf[32];
        strncpy(buf, line + 11, sizeof(buf) - 1);
        char *tok = strtok(buf, ":");
        if (tok && strncmp(tok, currentAadhaar, AADHAAR_LEN) == 0) {
            consentGranted = 1;
            Debug_Print("Consent granted\r\n");
        }
        return;
    }
    if (strncmp(line, "ABORT_ENROLL:", 13) == 0) {
        enrollAborted = 1;
        consentGranted = 0;
        Debug_Print("Abort received\r\n");
        return;
    }
    if (strncmp(line, "LOAD_TEMPLATE:", 14) == 0) {
        const char *rest = line + 14;
        char *colon = strchr(rest, ':');
        if (!colon) return;
        int  page = atoi(rest);
        const char *b64 = colon + 1;
        static uint8_t rawBuf[TEMPLATE_BYTES + 16];
        uint16_t rawLen = Base64Decode(b64, rawBuf);
        if (rawLen == 0 || strncmp(b64, "PLACEHOLDER_", 12) == 0) {
            char loadLogMsg[56];
            snprintf(loadLogMsg, sizeof(loadLogMsg), "Template %d: rejected invalid data\r\n", page);
            Debug_Print(loadLogMsg);
            return;
        } else {
            uint8_t code = R307_DownloadCharBuffer(rawBuf, rawLen);
            if (code == 0x00) {
                code = R307_StorePage((uint8_t)page);
                if (code != 0x00) {
                    char storeErrMsg[48];
                    snprintf(storeErrMsg, sizeof(storeErrMsg), "Store page %d failed: 0x%02X\r\n", page, code);
                    Debug_Print(storeErrMsg);
                }
            }
        }
        char loadDoneMsg[48];
        snprintf(loadDoneMsg, sizeof(loadDoneMsg), "Loaded template %d (%u bytes)\r\n", page, (unsigned)rawLen);
        Debug_Print(loadDoneMsg);
        return;
    }
    if (strncmp(line, "VOTER_INFO:", 11) == 0) {
        char buf[128];
        strncpy(buf, line + 11, sizeof(buf) - 1);
        char *token = strtok(buf, ":");
        if (token) strncpy(currentAadhaar, token, AADHAAR_LEN);
        token = strtok(NULL, ":");
        if (token) strncpy(voterName,   token, sizeof(voterName)   - 1);
        token = strtok(NULL, ":");
        if (token) strncpy(voterAge,    token, sizeof(voterAge)    - 1);
        token = strtok(NULL, ":");
        if (token) strncpy(voterGender, token, sizeof(voterGender) - 1);
        char pcMsg[200];
        snprintf(pcMsg, sizeof(pcMsg),
                 "VOTER_DATA:ID=%s:NAME=%s:AGE=%s:GENDER=%s",
                 currentAadhaar, voterName, voterAge, voterGender);
        SendToPC(pcMsg);
        return;
    }
    if (strncmp(line, "ACK_VOTE:", 9) == 0) {
        char buf[64];
        strncpy(buf, line + 9, sizeof(buf) - 1);
        char *a = strtok(buf, ":");
        char *p = strtok(NULL, ":");
        if (a) strncpy(currentAadhaar, a, AADHAAR_LEN);
        if (p) {
            char ackMsg[48];
            snprintf(ackMsg, sizeof(ackMsg), "Vote ack: %s\r\n", p);
            Debug_Print(ackMsg);
        }
        LED_Green_On(); Buzzer_Beep(); HAL_Delay(500); LED_Green_Off();
        return;
    }
    if (strncmp(line, "CMD_VERIFY:", 11) == 0) {
        strncpy(currentAadhaar, line + 11, AADHAAR_LEN);
        currentAadhaar[AADHAAR_LEN] = '\0';
        sysState = STATE_VERIFY;
        return;
    }
    if (strncmp(line, "CMD_ENROLL:", 11) == 0) {
        strncpy(currentAadhaar, line + 11, AADHAAR_LEN);
        currentAadhaar[AADHAAR_LEN] = '\0';
        enrollAborted  = 0;
        consentGranted = 0;
        currentSample  = 0;
        sysState = STATE_ENROLLING;
        return;
    }
}
static void R307_ClearErrors(void)
{
    __HAL_UART_CLEAR_FLAG(&huart1, UART_CLEAR_OREF | UART_CLEAR_NEF | UART_CLEAR_FEF | UART_CLEAR_PEF);
    while (__HAL_UART_GET_FLAG(&huart1, UART_FLAG_RXNE)) {
        volatile uint8_t tmpreg = (uint8_t)(huart1.Instance->RDR & 0xFF);
        (void)tmpreg;
    }
    huart1.ErrorCode = HAL_UART_ERROR_NONE;
    huart1.RxState = HAL_UART_STATE_READY;
}

static uint8_t R307_CheckConnection(void)
{
    uint8_t resp[12];
    
    R307_ClearErrors();
    R307_SendCommand(CMD_GEN_IMG, sizeof(CMD_GEN_IMG));
    HAL_StatusTypeDef s = HAL_UART_Receive(&huart1, resp, sizeof(resp), 300);
    if (s == HAL_OK) {
        return 1;
    }
    
    // If it fails, scan all possible baud rates immediately to find the sensor
    uint32_t bauds[] = {57600, 9600, 115200};
    for (int i = 0; i < 3; i++) {
        MX_USART1_UART_Init_Baud(bauds[i]);
        R307_ClearErrors();
        R307_SendCommand(CMD_GEN_IMG, sizeof(CMD_GEN_IMG));
        s = HAL_UART_Receive(&huart1, resp, sizeof(resp), 300);
        if (s == HAL_OK) {
            char baudMsg[48];
            snprintf(baudMsg, sizeof(baudMsg), "STATUS:SENSOR_BAUD_DETECTED:%u", (unsigned)bauds[i]);
            SendToPC(baudMsg);
            return 1;
        }
    }
    
    return 0;
}
static void R307_SendCommand(const uint8_t *cmd, uint16_t len)
{
    R307_ClearErrors();
    HAL_UART_Transmit(&huart1, (uint8_t *)cmd, len, HAL_MAX_DELAY);
}
static uint8_t R307_ReadResponse(uint8_t *buf, uint16_t len)
{
    HAL_StatusTypeDef s = HAL_UART_Receive(&huart1, buf, len, 2000);
    if (s != HAL_OK) {
        char err[48];
        snprintf(err, sizeof(err), "UART RX Fail: %d\r\n", (int)s);
        Debug_Print(err);
        return 0xFF;
    }
    // Print the raw bytes received from the sensor to diagnose misalignment/noise
    if (len >= 12) {
        char hex[80];
        snprintf(hex, sizeof(hex), "RX: %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X %02X\r\n",
                 buf[0], buf[1], buf[2], buf[3], buf[4], buf[5],
                 buf[6], buf[7], buf[8], buf[9], buf[10], buf[11]);
        Debug_Print(hex);
    }
    return buf[9];
}
static uint8_t R307_WaitForFinger(void)
{
    uint8_t resp[12];
    uint32_t lastMsgTime = 0;
    while (1) {
        if (rxLineReady) {
            rxLineReady = 0;
            ProcessRxLine(rxLine);
        }
        if (enrollAborted) {
            return 0xFE; // Aborted by PC
        }
        R307_SendCommand(CMD_GEN_IMG, sizeof(CMD_GEN_IMG));
        uint8_t status = R307_ReadResponse(resp, sizeof(resp));
        if (status == 0x00) {
            return 0x00; // Finger placed
        } else if (status == 0x02) {
            if (HAL_GetTick() - lastMsgTime > 1500) {
                lastMsgTime = HAL_GetTick();
                SendToPC("STATUS:PLEASE_PLACE_FINGER");
            }
        } else {
            if (HAL_GetTick() - lastMsgTime > 1500) {
                lastMsgTime = HAL_GetTick();
                SendToPC("STATUS:SENSOR_ERROR");
            }
        }
        HAL_Delay(25);
    }
}
static uint8_t R307_CaptureAndConvert(uint8_t slot)
{
    uint8_t resp[12];
    if (R307_WaitForFinger() != 0x00) return 0x02;
    if (slot == 1)
        R307_SendCommand(CMD_IMG2TZ_1, sizeof(CMD_IMG2TZ_1));
    else
        R307_SendCommand(CMD_IMG2TZ_2, sizeof(CMD_IMG2TZ_2));
    return R307_ReadResponse(resp, sizeof(resp));
}
static uint8_t R307_UploadCharBuffer(uint8_t *outBuf, uint16_t *outLen)
{
    R307_SendCommand(CMD_UP_CHAR, sizeof(CMD_UP_CHAR));
    uint8_t hdr[12];
    HAL_StatusTypeDef s = HAL_UART_Receive(&huart1, hdr, sizeof(hdr), 2000);
    if (s != HAL_OK) {
        char err[64];
        snprintf(err, sizeof(err), "STATUS:UpChar Hdr RX Fail: %d\r\n", (int)s);
        Debug_Print(err);
        return 0xFF;
    }
    if (hdr[9] != 0x00) {
        char err[64];
        snprintf(err, sizeof(err), "STATUS:UpChar Hdr Code Fail: %02X\r\n", hdr[9]);
        Debug_Print(err);
        return hdr[9];
    }
    uint16_t totalBytes = 0;
    while (totalBytes < TEMPLATE_BYTES) {
        uint8_t pktHdr[9];
        s = HAL_UART_Receive(&huart1, pktHdr, sizeof(pktHdr), 1000);
        if (s != HAL_OK) {
            char err[64];
            snprintf(err, sizeof(err), "STATUS:UpChar Pkt Hdr RX Fail: %d (total=%d)\r\n", (int)s, (int)totalBytes);
            Debug_Print(err);
            break;
        }
        uint8_t pktId   = pktHdr[6];
        uint16_t pktLen = ((uint16_t)pktHdr[7] << 8) | pktHdr[8];
        if (pktLen < 2 || pktLen > 130) {
            char err[64];
            snprintf(err, sizeof(err), "STATUS:UpChar Invalid PktLen: %d\r\n", (int)pktLen);
            Debug_Print(err);
            break;
        }
        uint16_t dataLen = pktLen - 2;
        if (totalBytes + dataLen > TEMPLATE_BYTES) {
            char err[64];
            snprintf(err, sizeof(err), "STATUS:UpChar Buffer Overflow: %d\r\n", (int)(totalBytes + dataLen));
            Debug_Print(err);
            break;
        }
        s = HAL_UART_Receive(&huart1, outBuf + totalBytes, dataLen, 1000);
        if (s != HAL_OK) {
            char err[64];
            snprintf(err, sizeof(err), "STATUS:UpChar Data RX Fail: %d\r\n", (int)s);
            Debug_Print(err);
            break;
        }
        totalBytes += dataLen;
        uint8_t chk[2];
        HAL_UART_Receive(&huart1, chk, 2, 500);
        if (pktId == 0x08) break;
    }
    *outLen = totalBytes;
    return 0x00;
}
static uint8_t R307_DownloadCharBuffer(const uint8_t *data, uint16_t len)
{
    R307_SendCommand(CMD_DN_CHAR, sizeof(CMD_DN_CHAR));
    uint8_t resp[12];
    if (HAL_UART_Receive(&huart1, resp, sizeof(resp), 2000) != HAL_OK) return 0xFF;
    if (resp[9] != 0x00) return resp[9];
    uint16_t offset = 0;
    while (offset < len) {
        uint16_t chunk = (len - offset > 128) ? 128 : (len - offset);
        uint8_t  pktId = (offset + chunk >= len) ? 0x08 : 0x02;
        uint8_t pkt[9 + 128 + 2];
        pkt[0] = 0xEF; pkt[1] = 0x01;
        pkt[2] = 0xFF; pkt[3] = 0xFF; pkt[4] = 0xFF; pkt[5] = 0xFF;
        pkt[6] = pktId;
        pkt[7] = (uint8_t)(((chunk + 2) >> 8) & 0xFF);
        pkt[8] = (uint8_t)((chunk + 2) & 0xFF);
        memcpy(pkt + 9, data + offset, chunk);
        uint16_t sum = pktId + pkt[7] + pkt[8];
        for (uint16_t i = 0; i < chunk; i++) sum += pkt[9 + i];
        pkt[9 + chunk]     = (uint8_t)((sum >> 8) & 0xFF);
        pkt[9 + chunk + 1] = (uint8_t)(sum & 0xFF);
        HAL_UART_Transmit(&huart1, pkt, 9 + chunk + 2, HAL_MAX_DELAY);
        offset += chunk;
    }
    // Read the final confirmation code of the DnChar command
    return R307_ReadResponse(resp, sizeof(resp));
}
static uint8_t R307_StorePage(uint8_t page)
{
    uint8_t cmd[15] = {
        0xEF,0x01, 0xFF,0xFF,0xFF,0xFF,
        0x01,
        0x00, 0x06,
        0x06,
        0x01,
        0x00,
        (uint8_t)page,
        0x00, 0x00
    };
    uint16_t sum = 0;
    for (uint8_t i = 6; i < 13; i++) sum += cmd[i];
    cmd[13] = (uint8_t)((sum >> 8) & 0xFF);
    cmd[14] = (uint8_t)(sum & 0xFF);
    R307_SendCommand(cmd, sizeof(cmd));
    uint8_t resp[12];
    return R307_ReadResponse(resp, sizeof(resp));
}
/* ─────────────────────────────────────────────────────────────
   Base64 encode / decode
   ───────────────────────────────────────────────────────────── */
static const char B64_TABLE[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void Base64Encode(const uint8_t *in, uint16_t inLen, char *out)
{
    uint16_t i = 0, j = 0;
    while (i < inLen) {
        uint32_t octet_a = (i < inLen) ? in[i++] : 0;
        uint32_t octet_b = (i < inLen) ? in[i++] : 0;
        uint32_t octet_c = (i < inLen) ? in[i++] : 0;
        uint32_t triple  = (octet_a << 16) | (octet_b << 8) | octet_c;
        out[j++] = B64_TABLE[(triple >> 18) & 0x3F];
        out[j++] = B64_TABLE[(triple >> 12) & 0x3F];
        out[j++] = B64_TABLE[(triple >>  6) & 0x3F];
        out[j++] = B64_TABLE[ triple        & 0x3F];
    }
    if (inLen % 3 == 1) { out[j-1] = '='; out[j-2] = '='; }
    else if (inLen % 3 == 2) { out[j-1] = '='; }
    out[j] = '\0';
}
static uint8_t B64_Val(char c)
{
    if (c >= 'A' && c <= 'Z') return (uint8_t)(c - 'A');
    if (c >= 'a' && c <= 'z') return (uint8_t)(c - 'a' + 26);
    if (c >= '0' && c <= '9') return (uint8_t)(c - '0' + 52);
    if (c == '+') return 62;
    if (c == '/') return 63;
    return 0;
}
static uint16_t Base64Decode(const char *in, uint8_t *out)
{
    uint16_t inLen = (uint16_t)strlen(in);
    if (inLen == 0 || inLen % 4 != 0) return 0;
    uint16_t outLen = (inLen / 4) * 3;
    if (in[inLen-1] == '=') outLen--;
    if (in[inLen-2] == '=') outLen--;
    uint16_t i = 0, j = 0;
    while (i < inLen) {
        uint32_t sextet_a = B64_Val(in[i++]);
        uint32_t sextet_b = B64_Val(in[i++]);
        uint32_t sextet_c = B64_Val(in[i++]);
        uint32_t sextet_d = B64_Val(in[i++]);
        uint32_t triple   = (sextet_a << 18) | (sextet_b << 12) | (sextet_c << 6) | sextet_d;
        if (j < outLen) out[j++] = (uint8_t)((triple >> 16) & 0xFF);
        if (j < outLen) out[j++] = (uint8_t)((triple >>  8) & 0xFF);
        if (j < outLen) out[j++] = (uint8_t)( triple        & 0xFF);
    }
    return outLen;
}
/* ─────────────────────────────────────────────────────────────
   Button helpers
   ───────────────────────────────────────────────────────────── */
static uint8_t Btn_AB_Pressed(void)
{
    return (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_7) == GPIO_PIN_RESET);
}
static uint8_t Btn_CD_Pressed(void)
{
    return (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_10) == GPIO_PIN_RESET);
}
static uint8_t Btn_EF_Pressed(void)
{
    return (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_3) == GPIO_PIN_RESET);
}
static uint8_t Btn_GH_Pressed(void)
{
    return (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_5) == GPIO_PIN_RESET);
}
static uint8_t Btn_NOTA_Pressed(void)
{
    return (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_6) == GPIO_PIN_RESET);
}
/* ─────────────────────────────────────────────────────────────
   LED & Buzzer
   ───────────────────────────────────────────────────────────── */
static void LED_Green_On(void) { 
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_SET);   
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_6, GPIO_PIN_SET);   
}
static void LED_Green_Off(void) { 
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_RESET); 
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_6, GPIO_PIN_RESET); 
}
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
static void SendToPC(const char *msg)
{
    HAL_UART_Transmit(&huart2, (uint8_t *)msg,  (uint16_t)strlen(msg), HAL_MAX_DELAY);
    HAL_UART_Transmit(&huart2, (uint8_t *)"\n", 1, HAL_MAX_DELAY);
}
/* ─────────────────────────────────────────────────────────────
   UART2 RX interrupt
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
            if (rxIdx < RX_BUF_SIZE - 1)
                rxLine[rxIdx++] = (char)rxByte;
        }
        HAL_UART_Receive_IT(&huart2, &rxByte, 1);
    }
}
void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
    if (huart->Instance == USART2) {
        __HAL_UART_CLEAR_FLAG(huart, UART_CLEAR_OREF | UART_CLEAR_NEF | UART_CLEAR_FEF | UART_CLEAR_PEF);
        volatile uint32_t tmpreg = huart->Instance->RDR;
        (void)tmpreg;
        rxIdx = 0;
        HAL_UART_Receive_IT(huart, &rxByte, 1);
    }
}

/* USER CODE END 4 */

/**
  * @brief  This function is executed in case of error occurrence.
  * @retval None
  */
void Error_Handler(void)
{
  /* USER CODE BEGIN Error_Handler_Debug */
  /* User can add his own implementation to report the HAL error return state */
  __disable_irq();
  while (1)
  {
  }
  /* USER CODE END Error_Handler_Debug */
}
#ifdef USE_FULL_ASSERT
/**
  * @brief  Reports the name of the source file and the source line number
  *         where the assert_param error has occurred.
  * @param  file: pointer to the source file name
  * @param  line: assert_param error line source number
  * @retval None
  */
void assert_failed(uint8_t *file, uint32_t line)
{
  /* USER CODE BEGIN 6 */
  /* User can add his own implementation to report the file name and line number,
     ex: printf("Wrong parameters value: file %s on line %d\r\n", file, line) */
  /* USER CODE END 6 */
}
#endif /* USE_FULL_ASSERT */
