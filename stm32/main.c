/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file           : main.c
  * @brief          : Standalone EVM - Custom Registration & Verification Flow
  *                   with High-Speed On-Sensor Flash Database, Software SPI SD Card
  *                   & STM32 Internal Flash Dual-Redundancy Storage
  ******************************************************************************
  */
/* USER CODE END Header */

#include "main.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>

typedef enum {
    STATE_BOOT,
    STATE_ADMIN_ENROLL_VOTER,
    STATE_POST_REG_MENU,
    STATE_WAIT_AADHAAR,
    STATE_SHOW_RESULTS
} SystemState;

typedef struct {
    char aadhaar[13];
    char phone[11];
    uint8_t day;
    uint8_t month;
    uint16_t year;
    char gender; // 'M' or 'F'
    uint8_t has_voted;
    uint8_t sensor_start_id; // Starting slot index in sensor flash (5 fingers per voter)
} VoterRecord;

UART_HandleTypeDef huart1;
UART_HandleTypeDef huart2;

SystemState currentState = STATE_BOOT;
SystemState lastState = STATE_BOOT;

#define MAX_VOTERS 20
VoterRecord voterDatabase[MAX_VOTERS];
uint8_t totalVoters = 0;

uint16_t partyVotes[5] = {0}; // BJP, INC, AAP, BSP, NOTA

VoterRecord currentVoter;
int currentVoterIdx = -1;

char input_buffer[16] = {0};
uint8_t input_len = 0;

uint8_t btn_idle_states[5] = {1, 1, 1, 1, 1};

char keypad_map[4][3] = {
    {'1', '2', '3'},
    {'4', '5', '6'},
    {'7', '8', '9'},
    {'*', '0', '#'}
};

uint8_t rxByte;
char rxLine[1024] = {0};
uint8_t rxIdx = 0;
volatile uint8_t rxLineReady = 0;

void SystemClock_Config(void);
static void MX_GPIO_Init(void);
static void MX_USART1_UART_Init(void);
static void MX_USART2_UART_Init(void);
char Keypad_Scan(void);
void LCD_Print(const char *line1, const char *line2);
int Get_Voted_Candidate(void);
void Buttons_AutoDetect_Init(void);

// R307 Drivers
void R307_SendPacket(uint8_t type, uint16_t length, const uint8_t *content);
uint8_t R307_ReceiveResponse(uint8_t *codeOut);
uint8_t R307_CaptureFingerprint(uint8_t buffer_id, uint8_t *quality_code);
uint8_t R307_StoreTemplate(uint8_t buffer_id, uint16_t page_id);
uint8_t R307_SearchDatabase(uint8_t buffer_id, uint16_t *page_id, uint16_t *score);
uint8_t R307_EmptyDatabase(void);
uint8_t R307_RegModel(void);
void R307_WaitFingerLift(void);
void R307_FlushRX(void);

// Waveshare SPI OLED Pins & Drivers (OLED CS is PA0/A0)
#define OLED_CS_LOW()   HAL_GPIO_WritePin(GPIOA, GPIO_PIN_0, GPIO_PIN_RESET)
#define OLED_CS_HIGH()  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_0, GPIO_PIN_SET)
#define OLED_DC_LOW()   HAL_GPIO_WritePin(GPIOC, GPIO_PIN_0, GPIO_PIN_RESET)
#define OLED_DC_HIGH()  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_0, GPIO_PIN_SET)
#define OLED_RES_LOW()  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_RESET)
#define OLED_RES_HIGH() HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_SET)

void OLED_WriteCommand(uint8_t cmd);
void OLED_WriteData(uint8_t data);
void OLED_Init(void);
void OLED_Clear(void);
void OLED_SetCursor(uint8_t row, uint8_t col);
void OLED_PrintString(uint8_t row, uint8_t col, const char *str);

// Software SPI SD Card Drivers (Conflict-Free Socket Pins)
#define SD_CS_LOW()     HAL_GPIO_WritePin(GPIOA, GPIO_PIN_1, GPIO_PIN_RESET)
#define SD_CS_HIGH()    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_1, GPIO_PIN_SET)
#define SD_SCK_LOW()    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, GPIO_PIN_RESET)
#define SD_SCK_HIGH()   HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, GPIO_PIN_SET)
#define SD_MOSI_LOW()   HAL_GPIO_WritePin(GPIOA, GPIO_PIN_7, GPIO_PIN_RESET)
#define SD_MOSI_HIGH()  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_7, GPIO_PIN_SET)
#define SD_MISO_READ()  HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_4)

uint8_t SD_SPI_Transfer(uint8_t byte);
uint8_t SD_SendCommand(uint8_t cmd, uint32_t arg, uint8_t crc);
uint8_t SD_Init(void);
uint8_t SD_WriteBlock(uint32_t sector, const uint8_t *buffer);
uint8_t SD_ReadBlock(uint32_t sector, uint8_t *buffer);
void Save_Database_To_SD(void);
void Load_Database_From_SD(void);
void Save_Database_To_Flash(void);
void Load_Database_From_Flash(void);

char Get_Input_Char(void);
void Init_Mock_Database(void);
uint8_t Validate_Aadhaar(const char *aadhaar);
uint8_t Validate_DOB(uint8_t day, uint8_t month, uint16_t year);

void Buzzer_Beep(uint16_t duration_ms);
void Buzzer_Error(void);

/* --- SD CARD DRIVER IMPLEMENTATION --- */
uint8_t SD_SPI_Transfer(uint8_t byte) {
    uint8_t res = 0;
    for(int i = 0; i < 8; i++) {
        if(byte & 0x80) SD_MOSI_HIGH();
        else SD_MOSI_LOW();
        byte <<= 1;
        for(volatile int d = 0; d < 20; d++);
        SD_SCK_HIGH();
        for(volatile int d = 0; d < 20; d++);
        res <<= 1;
        if(SD_MISO_READ() == GPIO_PIN_SET) res |= 1;
        SD_SCK_LOW();
        for(volatile int d = 0; d < 20; d++);
    }
    return res;
}

uint8_t SD_SendCommand(uint8_t cmd, uint32_t arg, uint8_t crc) {
    uint8_t res;
    SD_CS_HIGH();
    SD_SPI_Transfer(0xFF);
    SD_CS_LOW();
    SD_SPI_Transfer(0x40 | cmd);
    SD_SPI_Transfer((arg >> 24) & 0xFF);
    SD_SPI_Transfer((arg >> 16) & 0xFF);
    SD_SPI_Transfer((arg >> 8) & 0xFF);
    SD_SPI_Transfer(arg & 0xFF);
    SD_SPI_Transfer(crc);
    for(int i = 0; i < 200; i++) {
        res = SD_SPI_Transfer(0xFF);
        if((res & 0x80) == 0) return res;
    }
    return 0xFF;
}

uint8_t SD_Init(void) {
    SD_CS_HIGH();
    SD_MOSI_HIGH();
    for(int i = 0; i < 15; i++) SD_SPI_Transfer(0xFF);
    uint8_t r = SD_SendCommand(0, 0, 0x95);
    if(r != 0x01 && r != 0x00) {
        SD_CS_HIGH();
        return 0;
    }
    r = SD_SendCommand(8, 0x1AA, 0x87);
    if(r == 0x01) {
        SD_SPI_Transfer(0xFF); SD_SPI_Transfer(0xFF);
        SD_SPI_Transfer(0xFF); SD_SPI_Transfer(0xFF);
        SD_CS_HIGH();
        SD_SPI_Transfer(0xFF);
    }
    uint32_t start = HAL_GetTick();
    while(1) {
        SD_SendCommand(55, 0, 0x65);
        uint8_t r41 = SD_SendCommand(41, 0x40000000, 0x77);
        if(r41 == 0x00) break;
        if((HAL_GetTick() - start) > 2000) {
            SD_CS_HIGH();
            return 0;
        }
    }
    SD_CS_HIGH();
    SD_SPI_Transfer(0xFF);
    return 1;
}

uint8_t SD_WriteBlock(uint32_t sector, const uint8_t *buffer) {
    uint8_t r = SD_SendCommand(24, sector, 0xFF);
    if(r != 0x00) {
        SD_CS_HIGH();
        return 0;
    }
    SD_SPI_Transfer(0xFE);
    for(int i = 0; i < 512; i++) {
        SD_SPI_Transfer(buffer[i]);
    }
    SD_SPI_Transfer(0xFF);
    SD_SPI_Transfer(0xFF);
    r = SD_SPI_Transfer(0xFF);
    if((r & 0x1F) != 0x05) {
        SD_CS_HIGH();
        return 0;
    }
    uint32_t start = HAL_GetTick();
    while(SD_SPI_Transfer(0xFF) == 0x00) {
        if((HAL_GetTick() - start) > 50) {
            SD_CS_HIGH();
            return 0;
        }
    }
    SD_CS_HIGH();
    SD_SPI_Transfer(0xFF);
    return 1;
}

uint8_t SD_ReadBlock(uint32_t sector, uint8_t *buffer) {
    uint8_t r = SD_SendCommand(17, sector, 0xFF);
    if(r != 0x00) {
        SD_CS_HIGH();
        return 0;
    }
    uint32_t start = HAL_GetTick();
    while(SD_SPI_Transfer(0xFF) != 0xFE) {
        if((HAL_GetTick() - start) > 50) {
            SD_CS_HIGH();
            return 0;
        }
    }
    for(int i = 0; i < 512; i++) {
        buffer[i] = SD_SPI_Transfer(0xFF);
    }
    SD_SPI_Transfer(0xFF);
    SD_SPI_Transfer(0xFF);
    SD_CS_HIGH();
    SD_SPI_Transfer(0xFF);
    return 1;
}

void Save_Database_To_SD(void) {
    LCD_Print("Saving to SD...", "Please Wait");
    HAL_Delay(100);
    uint8_t sd_ok = 0;
    for (int retry = 0; retry < 5; retry++) {
        if (SD_Init()) {
            sd_ok = 1;
            break;
        }
        HAL_Delay(100);
    }
    if (!sd_ok) {
        LCD_Print("SD Card Fail", "Cannot Save Data");
        HAL_Delay(2000);
        return;
    }
    uint8_t sector_buf[512] = {0};
    sector_buf[0] = totalVoters;
    for (int i = 0; i < 5; i++) {
        sector_buf[1 + i * 2] = (partyVotes[i] >> 8) & 0xFF;
        sector_buf[2 + i * 2] = partyVotes[i] & 0xFF;
    }
    SD_WriteBlock(2000, sector_buf);
    
    uint8_t *ptr = (uint8_t*)voterDatabase;
    uint32_t size = totalVoters * sizeof(VoterRecord);
    uint32_t num_sectors = (size + 511) / 512;
    for(uint32_t i = 0; i < num_sectors; i++) {
        memset(sector_buf, 0, 512);
        uint32_t bytes_to_copy = (size - (i * 512) > 512) ? 512 : (size - (i * 512));
        memcpy(sector_buf, ptr + (i * 512), bytes_to_copy);
        SD_WriteBlock(2001 + i, sector_buf);
    }
    LCD_Print("DB Saved to SD!", "");
    HAL_Delay(1000);
}

void Load_Database_From_SD(void) {
    LCD_Print("Initializing SD...", "");
    HAL_Delay(1000);
    uint8_t sd_ok = 0;
    for (int retry = 0; retry < 5; retry++) {
        if (SD_Init()) {
            sd_ok = 1;
            break;
        }
        HAL_Delay(200);
    }
    if (!sd_ok) {
        totalVoters = 0;
        LCD_Print("SD Card Fail", "Using Empty DB");
        HAL_Delay(2000);
        return;
    }
    uint8_t sector_buf[512];
    if (SD_ReadBlock(2000, sector_buf)) {
        totalVoters = sector_buf[0];
        if (totalVoters > MAX_VOTERS) totalVoters = 0;
        for (int i = 0; i < 5; i++) {
            partyVotes[i] = (sector_buf[1 + i * 2] << 8) | sector_buf[2 + i * 2];
        }
    } else {
        totalVoters = 0;
        return;
    }
    uint8_t *ptr = (uint8_t*)voterDatabase;
    uint32_t size = totalVoters * sizeof(VoterRecord);
    uint32_t num_sectors = (size + 511) / 512;
    for(uint32_t i = 0; i < num_sectors; i++) {
        if (SD_ReadBlock(2001 + i, sector_buf)) {
            uint32_t bytes_to_copy = (size - (i * 512) > 512) ? 512 : (size - (i * 512));
            memcpy(ptr + (i * 512), sector_buf, bytes_to_copy);
        }
    }
    LCD_Print("DB Loaded from SD", "");
    HAL_Delay(2000);
}

#define FLASH_STORAGE_ADDR 0x0800F800 // Page 31 of Flash (compatible with 64KB, 128KB and larger MCUs)

void Save_Database_To_Flash(void) {
    __disable_irq();
    HAL_FLASH_Unlock();
    __HAL_FLASH_CLEAR_FLAG(FLASH_FLAG_ALL_ERRORS);
    
    FLASH_EraseInitTypeDef EraseInitStruct;
    EraseInitStruct.TypeErase = FLASH_TYPEERASE_PAGES;
    EraseInitStruct.Banks = FLASH_BANK_1;
    EraseInitStruct.Page = (FLASH_STORAGE_ADDR - 0x08000000) / 2048; 
    EraseInitStruct.NbPages = 1;
    
    uint32_t PageError = 0;
    HAL_StatusTypeDef status = HAL_FLASHEx_Erase(&EraseInitStruct, &PageError);
    if (status != HAL_OK) {
        char err_msg[64];
        sprintf(err_msg, "[DEBUG] Flash Erase Failed! Status: %d\r\n", status);
        HAL_UART_Transmit(&huart2, (uint8_t*)err_msg, strlen(err_msg), 100);
        HAL_FLASH_Lock();
        __enable_irq();
        return;
    }
    
    uint64_t data_buf[128] = {0};
    data_buf[0] = totalVoters;
    for (int i = 0; i < 5; i++) {
        data_buf[1 + i] = partyVotes[i];
    }
    uint8_t *db_bytes = (uint8_t*)voterDatabase;
    uint8_t *dest_bytes = (uint8_t*)&data_buf[6];
    memcpy(dest_bytes, db_bytes, sizeof(voterDatabase));
    
    uint32_t addr = FLASH_STORAGE_ADDR;
    uint8_t prog_ok = 1;
    for (int i = 0; i < 128; i++) {
        status = HAL_FLASH_Program(FLASH_TYPEPROGRAM_DOUBLEWORD, addr, data_buf[i]);
        if (status != HAL_OK) {
            char err_msg[64];
            sprintf(err_msg, "[DEBUG] Flash Write Failed at offset %d! Status: %d\r\n", i, status);
            HAL_UART_Transmit(&huart2, (uint8_t*)err_msg, strlen(err_msg), 100);
            prog_ok = 0;
            break;
        }
        addr += 8;
    }
    if (prog_ok) {
        HAL_UART_Transmit(&huart2, (uint8_t*)"[DEBUG] Flash Save SUCCESS!\r\n", 29, 100);
    }
    HAL_FLASH_Lock();
    __enable_irq();
}

void Load_Database_From_Flash(void) {
    uint64_t *flash_ptr = (uint64_t*)FLASH_STORAGE_ADDR;
    if (flash_ptr[0] == 0xFFFFFFFFFFFFFFFFULL) {
        totalVoters = 0;
        memset(partyVotes, 0, sizeof(partyVotes));
        return;
    }
    totalVoters = flash_ptr[0] & 0xFF;
    if (totalVoters > MAX_VOTERS) {
        totalVoters = 0;
        return;
    }
    for (int i = 0; i < 5; i++) {
        partyVotes[i] = flash_ptr[1 + i] & 0xFFFF;
    }
    uint8_t *db_bytes = (uint8_t*)voterDatabase;
    uint8_t *src_bytes = (uint8_t*)&flash_ptr[6];
    memcpy(db_bytes, src_bytes, sizeof(voterDatabase));
}

/* --- BUZZER FEEDBACK FUNCTIONS (ACTIVE-LOW COMPATIBLE) --- */
void Buzzer_Beep(uint16_t duration_ms) {
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET); // ON (Active-Low)
    HAL_Delay(duration_ms);
    HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET);   // OFF
}

void Buzzer_Error(void) {
    for (int i = 0; i < 3; i++) {
        HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET); // ON (Active-Low)
        HAL_Delay(150);
        HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET);   // OFF
        HAL_Delay(100);
    }
}

char Get_Input_Char(void) {
    char key = Keypad_Scan();
    if (key != 0) {
        if (currentState == STATE_ADMIN_ENROLL_VOTER || currentState == STATE_WAIT_AADHAAR) {
            if (key == '*') return '1';
            if (key == '#') return '2';
        }
        return key;
    }
    if (__HAL_UART_GET_FLAG(&huart2, UART_FLAG_RXNE)) {
        uint8_t c;
        if (HAL_UART_Receive(&huart2, &c, 1, 10) == HAL_OK) {
            HAL_UART_Transmit(&huart2, &c, 1, 10);
            if (currentState == STATE_ADMIN_ENROLL_VOTER || currentState == STATE_WAIT_AADHAAR) {
                if (c == '*') return '1';
                if (c == '#') return '2';
                if (c == '\r' || c == '\n') return '2';
            } else {
                if (c == '\r' || c == '\n') return '#';
                if (c == '*' || c == 127 || c == '\b') return '*';
            }
            if (c >= '0' && c <= '9') return c;
        }
    }
    return 0;
}

void Init_Mock_Database(void) {
    totalVoters = 0;
}

uint8_t Validate_Aadhaar(const char *aadhaar) {
    if (strlen(aadhaar) != 12) return 0;
    uint8_t identical = 1;
    for (int i = 1; i < 12; i++) {
        if (aadhaar[i] != aadhaar[0]) {
            identical = 0;
            break;
        }
    }
    if (identical) return 0;
    for (int i = 0; i < totalVoters; i++) {
        if (strcmp(voterDatabase[i].aadhaar, aadhaar) == 0) {
            return 2;
        }
    }
    return 1;
}

uint8_t Validate_DOB(uint8_t day, uint8_t month, uint16_t year) {
    if (year > 2026 || year < 1900) return 0;
    if (month < 1 || month > 12) return 0;
    if (day < 1) return 0;
    if (month == 2) {
        if (day > 28) return 0;
    } else if (month == 4 || month == 6 || month == 9 || month == 11) {
        if (day > 30) return 0;
    } else {
        if (day > 31) return 0;
    }
    return 1;
}

void Buttons_AutoDetect_Init(void) {
    btn_idle_states[0] = HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_7);
    btn_idle_states[1] = HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_10);
    btn_idle_states[2] = HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_3);
    btn_idle_states[3] = HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_5);
    btn_idle_states[4] = HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_0);
}

int Get_Voted_Candidate(void) {
    if (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_7) != btn_idle_states[0]) {
        HAL_Delay(40);
        if (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_7) != btn_idle_states[0]) {
            while (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_7) != btn_idle_states[0]);
            return 0;
        }
    }
    if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_10) != btn_idle_states[1]) {
        HAL_Delay(40);
        if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_10) != btn_idle_states[1]) {
            while (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_10) != btn_idle_states[1]);
            return 1;
        }
    }
    if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_3) != btn_idle_states[2]) {
        HAL_Delay(40);
        if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_3) != btn_idle_states[2]) {
            while (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_3) != btn_idle_states[2]);
            return 2;
        }
    }
    if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_5) != btn_idle_states[3]) {
        HAL_Delay(40);
        if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_5) != btn_idle_states[3]) {
            while (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_5) != btn_idle_states[3]);
            return 3;
        }
    }
    if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_0) != btn_idle_states[4]) {
        HAL_Delay(40);
        if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_0) != btn_idle_states[4]) {
            while (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_0) != btn_idle_states[4]);
            return 4;
        }
    }
    return -1;
}

char Keypad_Scan(void) {
    for (int r = 0; r < 4; r++) {
        HAL_GPIO_WritePin(GPIOB, GPIO_PIN_4, GPIO_PIN_SET);
        HAL_GPIO_WritePin(GPIOC, GPIO_PIN_4 | GPIO_PIN_5 | GPIO_PIN_6, GPIO_PIN_SET);
        switch(r) {
            case 0: HAL_GPIO_WritePin(GPIOB, GPIO_PIN_4, GPIO_PIN_RESET); break;
            case 1: HAL_GPIO_WritePin(GPIOC, GPIO_PIN_6, GPIO_PIN_RESET); break;
            case 2: HAL_GPIO_WritePin(GPIOC, GPIO_PIN_5, GPIO_PIN_RESET); break;
            case 3: HAL_GPIO_WritePin(GPIOC, GPIO_PIN_4, GPIO_PIN_RESET); break;
        }
        HAL_Delay(2);
        if (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_3) == GPIO_PIN_RESET) {
            uint32_t press_start = HAL_GetTick();
            while(HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_3) == GPIO_PIN_RESET);
            uint32_t press_duration = HAL_GetTick() - press_start;
            char key = keypad_map[r][0];
            if (press_duration >= 3000 && key == '4') return '1';
            return key;
        }
        if (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_2) == GPIO_PIN_RESET) {
            uint32_t press_start = HAL_GetTick();
            while(HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_2) == GPIO_PIN_RESET);
            uint32_t press_duration = HAL_GetTick() - press_start;
            char key = keypad_map[r][1];
            if (press_duration >= 3000 && key == '5') return '2';
            return key;
        }
        if (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_1) == GPIO_PIN_RESET) {
            uint32_t press_start = HAL_GetTick();
            while(HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_1) == GPIO_PIN_RESET);
            uint32_t press_duration = HAL_GetTick() - press_start;
            char key = keypad_map[r][2];
            if (press_duration >= 3000 && key == '6') return '3';
            return key;
        }
    }
    return 0;
}

void LCD_Print(const char *line1, const char *line2) {
    static char last_line1[64] = {0};
    static char last_line2[64] = {0};
    if (strcmp(line1, last_line1) != 0 || strcmp(line2, last_line2) != 0) {
        strcpy(last_line1, line1);
        strcpy(last_line2, line2);
        char terminal_buffer[128];
        sprintf(terminal_buffer, "\r\n[DISPLAY] %s | %s\r\n", line1, line2);
        HAL_UART_Transmit(&huart2, (uint8_t*)terminal_buffer, strlen(terminal_buffer), 100);
        
        OLED_Clear();
        OLED_PrintString(2, 6, line1);
        OLED_PrintString(5, 6, line2);
    }
}

void R307_FlushRX(void) {
    uint8_t dummy;
    HAL_UART_AbortReceive(&huart1);
    __HAL_UART_CLEAR_FLAG(&huart1, UART_CLEAR_OREF | UART_CLEAR_NEF | UART_CLEAR_FEF | UART_CLEAR_PEF);
    huart1.RxState = HAL_UART_STATE_READY;
    int max_flush = 100;
    while (__HAL_UART_GET_FLAG(&huart1, UART_FLAG_RXNE) && max_flush > 0) {
        HAL_UART_Receive(&huart1, &dummy, 1, 1);
        max_flush--;
    }
}

static const uint8_t PKT_HEADER[] = {0xEF, 0x01, 0xFF, 0xFF, 0xFF, 0xFF};

void R307_SendPacket(uint8_t type, uint16_t length, const uint8_t *content) {
    R307_FlushRX();
    uint8_t buffer[64];
    memcpy(buffer, PKT_HEADER, 6);
    buffer[6] = type;
    buffer[7] = (length >> 8) & 0xFF;
    buffer[8] = length & 0xFF;
    memcpy(&buffer[9], content, length - 2);
    uint16_t sum = type + ((length >> 8) & 0xFF) + (length & 0xFF);
    for (int i = 0; i < length - 2; i++) sum += content[i];
    buffer[9 + length - 2] = (sum >> 8) & 0xFF;
    buffer[9 + length - 1] = sum & 0xFF;
    HAL_UART_Transmit(&huart1, buffer, 9 + length, 200); // 200ms Tx Timeout
}

uint8_t R307_ReceiveResponse(uint8_t *codeOut) {
    uint8_t resp[16];
    if (HAL_UART_Receive(&huart1, resp, 12, 1000) == HAL_OK) { // Safe 1000ms Timeout (returns instantly on data)
        if (resp[0] == 0xEF && resp[1] == 0x01) {
            *codeOut = resp[9];
            return 1;
        } else {
            R307_FlushRX();
        }
    }
    return 0;
}

uint8_t R307_CaptureFingerprint(uint8_t buffer_id, uint8_t *quality_code) {
    uint8_t confirm_code = 0xFF;
    uint8_t gen_img_payload[] = {0x01};
    R307_SendPacket(0x01, 3, gen_img_payload);
    if (!R307_ReceiveResponse(&confirm_code)) return 0;
    *quality_code = confirm_code;
    if (confirm_code != 0x00) return 0;
    
    uint8_t img2tz_payload[] = {0x02, buffer_id};
    R307_SendPacket(0x01, 4, img2tz_payload);
    if (!R307_ReceiveResponse(&confirm_code) || confirm_code != 0x00) return 0;
    return 1;
}

uint8_t R307_StoreTemplate(uint8_t buffer_id, uint16_t page_id) {
    uint8_t payload[] = {0x06, buffer_id, (page_id >> 8) & 0xFF, page_id & 0xFF};
    R307_SendPacket(0x01, 6, payload);
    uint8_t confirm = 0xFF;
    if (R307_ReceiveResponse(&confirm) && confirm == 0x00) {
        return 1;
    }
    return 0;
}

uint8_t R307_SearchDatabase(uint8_t buffer_id, uint16_t *page_id, uint16_t *score) {
    uint8_t payload[] = {0x04, buffer_id, 0x00, 0x00, 0x01, 0x00};
    R307_SendPacket(0x01, 8, payload);
    uint8_t resp[16];
    if (HAL_UART_Receive(&huart1, resp, 16, 1000) == HAL_OK) { // 1000ms Search Timeout
        if (resp[0] == 0xEF && resp[1] == 0x01 && resp[9] == 0x00) {
            *page_id = (resp[10] << 8) | resp[11];
            *score = (resp[12] << 8) | resp[13];
            return 1;
        }
    }
    return 0;
}

uint8_t R307_SearchDatabaseRange(uint8_t buffer_id, uint16_t start_page, uint16_t page_num, uint16_t *page_id, uint16_t *score) {
    uint8_t payload[] = {
        0x04, 
        buffer_id, 
        (start_page >> 8) & 0xFF, 
        start_page & 0xFF, 
        (page_num >> 8) & 0xFF, 
        page_num & 0xFF
    };
    R307_SendPacket(0x01, 8, payload);
    uint8_t resp[16];
    if (HAL_UART_Receive(&huart1, resp, 16, 1000) == HAL_OK) { // 1000ms Search Timeout
        if (resp[0] == 0xEF && resp[1] == 0x01 && resp[9] == 0x00) {
            *page_id = (resp[10] << 8) | resp[11];
            *score = (resp[12] << 8) | resp[13];
            return 1;
        }
    }
    return 0;
}
uint8_t R307_LoadTemplate(uint8_t buffer_id, uint16_t page_id) {
    uint8_t payload[] = {0x07, buffer_id, (page_id >> 8) & 0xFF, page_id & 0xFF};
    R307_SendPacket(0x01, 6, payload);
    uint8_t confirm = 0xFF;
    if (R307_ReceiveResponse(&confirm) && confirm == 0x00) {
        return 1;
    }
    return 0;
}

uint8_t R307_Match(uint16_t *score) {
    uint8_t payload[] = {0x03};
    R307_SendPacket(0x01, 3, payload);
    uint8_t resp[16];
    if (HAL_UART_Receive(&huart1, resp, 14, 1000) == HAL_OK) { // 1000ms Match Timeout
        if (resp[0] == 0xEF && resp[1] == 0x01 && resp[9] == 0x00) {
            *score = (resp[10] << 8) | resp[11];
            return 1;
        }
    }
    return 0;
}

uint8_t R307_EmptyDatabase(void) {
    uint8_t payload[] = {0x0D};
    R307_SendPacket(0x01, 3, payload);
    uint8_t confirm = 0xFF;
    if (R307_ReceiveResponse(&confirm) && confirm == 0x00) {
        return 1;
    }
    return 0;
}

static const uint8_t Font5x7[][5] = {
    {0x00, 0x00, 0x00, 0x00, 0x00}, // Space (0x20)
    {0x00, 0x00, 0x5f, 0x00, 0x00}, // !
    {0x00, 0x07, 0x00, 0x07, 0x00}, // "
    {0x14, 0x7f, 0x14, 0x7f, 0x14}, // #
    {0x24, 0x2a, 0x7f, 0x2a, 0x12}, // $
    {0x23, 0x13, 0x08, 0x64, 0x62}, // %
    {0x36, 0x49, 0x55, 0x22, 0x50}, // &
    {0x00, 0x05, 0x03, 0x00, 0x00}, // '
    {0x00, 0x1c, 0x22, 0x41, 0x00}, // (
    {0x00, 0x41, 0x22, 0x1c, 0x00}, // )
    {0x14, 0x08, 0x3e, 0x08, 0x14}, // *
    {0x08, 0x08, 0x3e, 0x08, 0x08}, // +
    {0x00, 0x50, 0x30, 0x00, 0x00}, // ,
    {0x08, 0x08, 0x08, 0x08, 0x08}, // -
    {0x00, 0x60, 0x60, 0x00, 0x00}, // .
    {0x20, 0x10, 0x08, 0x04, 0x02}, // /
    {0x3e, 0x51, 0x49, 0x45, 0x3e}, // 0
    {0x00, 0x42, 0x7f, 0x40, 0x00}, // 1
    {0x42, 0x61, 0x51, 0x49, 0x46}, // 2
    {0x21, 0x41, 0x45, 0x4b, 0x31}, // 3
    {0x18, 0x14, 0x12, 0x7f, 0x10}, // 4
    {0x27, 0x45, 0x45, 0x45, 0x39}, // 5
    {0x3c, 0x4a, 0x49, 0x49, 0x30}, // 6
    {0x01, 0x71, 0x09, 0x05, 0x03}, // 7
    {0x36, 0x49, 0x49, 0x49, 0x36}, // 8
    {0x06, 0x49, 0x49, 0x29, 0x1e}, // 9
    {0x00, 0x36, 0x36, 0x00, 0x00}, // :
    {0x00, 0x56, 0x36, 0x00, 0x00}, // ;
    {0x08, 0x14, 0x22, 0x41, 0x00}, // <
    {0x24, 0x24, 0x24, 0x24, 0x24}, // =
    {0x00, 0x41, 0x22, 0x14, 0x08}, // >
    {0x02, 0x01, 0x51, 0x09, 0x06}, // ?
    {0x32, 0x49, 0x79, 0x41, 0x3e}, // @
    {0x7e, 0x11, 0x11, 0x11, 0x7e}, // A
    {0x7f, 0x49, 0x49, 0x49, 0x36}, // B
    {0x3e, 0x41, 0x41, 0x41, 0x22}, // C
    {0x7f, 0x41, 0x41, 0x22, 0x1c}, // D
    {0x7f, 0x49, 0x49, 0x49, 0x41}, // E
    {0x7f, 0x09, 0x09, 0x09, 0x01}, // F
    {0x3e, 0x41, 0x49, 0x49, 0x7a}, // G
    {0x7f, 0x08, 0x08, 0x08, 0x7f}, // H
    {0x00, 0x41, 0x7f, 0x41, 0x00}, // I
    {0x20, 0x40, 0x41, 0x3f, 0x01}, // J
    {0x7f, 0x08, 0x14, 0x22, 0x41}, // K
    {0x7f, 0x40, 0x40, 0x40, 0x40}, // L
    {0x7f, 0x02, 0x0c, 0x02, 0x7f}, // M
    {0x7f, 0x04, 0x08, 0x10, 0x7f}, // N
    {0x3e, 0x41, 0x41, 0x41, 0x3e}, // O
    {0x7f, 0x09, 0x09, 0x09, 0x06}, // P
    {0x3e, 0x41, 0x51, 0x21, 0x5e}, // Q
    {0x7f, 0x09, 0x19, 0x29, 0x46}, // R
    {0x46, 0x49, 0x49, 0x49, 0x31}, // S
    {0x01, 0x01, 0x7f, 0x01, 0x01}, // T
    {0x3f, 0x40, 0x40, 0x40, 0x3f}, // U
    {0x1f, 0x20, 0x40, 0x20, 0x1f}, // V
    {0x3f, 0x40, 0x38, 0x40, 0x3f}, // W
    {0x63, 0x14, 0x08, 0x14, 0x63}, // X
    {0x07, 0x08, 0x70, 0x08, 0x07}, // Y
    {0x61, 0x51, 0x49, 0x45, 0x43}, // Z
    {0x00, 0x7f, 0x41, 0x41, 0x00}, // [
    {0x02, 0x04, 0x08, 0x16, 0x20}, // Backslash
    {0x00, 0x41, 0x41, 0x7f, 0x00}, // ]
    {0x04, 0x02, 0x01, 0x02, 0x04}, // ^
    {0x40, 0x40, 0x40, 0x40, 0x40}, // _
    {0x00, 0x01, 0x02, 0x04, 0x00}, // `
    {0x20, 0x54, 0x54, 0x54, 0x78}, // a
    {0x7f, 0x48, 0x44, 0x44, 0x38}, // b
    {0x38, 0x44, 0x44, 0x44, 0x20}, // c
    {0x38, 0x44, 0x44, 0x48, 0x7f}, // d
    {0x38, 0x54, 0x54, 0x54, 0x18}, // e
    {0x08, 0x7e, 0x09, 0x01, 0x02}, // f
    {0x0c, 0x52, 0x52, 0x52, 0x3e}, // g
    {0x7f, 0x08, 0x04, 0x04, 0x78}, // h
    {0x00, 0x44, 0x7d, 0x40, 0x00}, // i
    {0x20, 0x40, 0x44, 0x3d, 0x00}, // j
    {0x7f, 0x10, 0x28, 0x44, 0x00}, // k
    {0x00, 0x41, 0x7f, 0x40, 0x00}, // l
    {0x7c, 0x04, 0x18, 0x04, 0x78}, // m
    {0x7c, 0x08, 0x04, 0x04, 0x78}, // n
    {0x38, 0x44, 0x44, 0x44, 0x38}, // o
    {0x7c, 0x14, 0x14, 0x14, 0x08}, // p
    {0x08, 0x14, 0x14, 0x18, 0x7c}, // q
    {0x7c, 0x08, 0x04, 0x04, 0x08}, // r
    {0x48, 0x54, 0x54, 0x54, 0x20}, // s
    {0x04, 0x3f, 0x44, 0x40, 0x20}, // t
    {0x3c, 0x40, 0x40, 0x20, 0x7c}, // u
    {0x1c, 0x20, 0x40, 0x20, 0x1c}, // v
    {0x3c, 0x40, 0x30, 0x40, 0x3c}, // w
    {0x44, 0x28, 0x10, 0x28, 0x44}, // x
    {0x0c, 0x50, 0x50, 0x50, 0x3c}, // y
    {0x44, 0x64, 0x54, 0x4c, 0x44}  // z
};

void OLED_WriteCommand(uint8_t cmd) {
    OLED_CS_LOW();
    OLED_DC_LOW();
    SD_SPI_Transfer(cmd);
    OLED_CS_HIGH();
}

void OLED_WriteData(uint8_t data) {
    OLED_CS_LOW();
    OLED_DC_HIGH();
    SD_SPI_Transfer(data);
    OLED_CS_HIGH();
}

void OLED_Init(void) {
    HAL_Delay(100);
    OLED_RES_HIGH();
    HAL_Delay(10);
    OLED_RES_LOW();
    HAL_Delay(20);
    OLED_RES_HIGH();
    HAL_Delay(50);

    OLED_WriteCommand(0xAE);
    OLED_WriteCommand(0xD5);
    OLED_WriteCommand(0x80);
    OLED_WriteCommand(0xA8);
    OLED_WriteCommand(0x3F);
    OLED_WriteCommand(0xD3);
    OLED_WriteCommand(0x00);
    OLED_WriteCommand(0x40);
    OLED_WriteCommand(0x8D);
    OLED_WriteCommand(0x14);
    OLED_WriteCommand(0x20);
    OLED_WriteCommand(0x02);
    OLED_WriteCommand(0xA1);
    OLED_WriteCommand(0xC8);
    OLED_WriteCommand(0xDA);
    OLED_WriteCommand(0x12);
    OLED_WriteCommand(0x81);
    OLED_WriteCommand(0xCF);
    OLED_WriteCommand(0xD9);
    OLED_WriteCommand(0xF1);
    OLED_WriteCommand(0xDB);
    OLED_WriteCommand(0x40);
    OLED_WriteCommand(0xA4);
    OLED_WriteCommand(0xA6);
    OLED_WriteCommand(0xAF);
    OLED_Clear();
}

void OLED_Clear(void) {
    for (uint8_t page = 0; page < 8; page++) {
        OLED_SetCursor(page, 0);
        for (uint8_t col = 0; col < 128; col++) {
            OLED_WriteData(0x00);
        }
    }
}

void OLED_SetCursor(uint8_t row, uint8_t col) {
    OLED_WriteCommand(0xB0 + row);
    OLED_WriteCommand(0x00 + (col & 0x0F));
    OLED_WriteCommand(0x10 + ((col >> 4) & 0x0F));
}

void OLED_PrintString(uint8_t row, uint8_t col, const char *str) {
    OLED_SetCursor(row, col);
    while (*str) {
        char c = *str++;
        if (c < 0x20 || c > 0x7E) c = ' ';
        uint8_t font_idx = c - 0x20;
        for (int i = 0; i < 5; i++) {
            OLED_WriteData(Font5x7[font_idx][i]);
        }
        OLED_WriteData(0x00);
    }
}

uint8_t R307_RegModel(void) {
    uint8_t payload[] = {0x05};
    R307_SendPacket(0x01, 3, payload);
    uint8_t confirm = 0xFF;
    if (R307_ReceiveResponse(&confirm) && confirm == 0x00) {
        return 1;
    }
    return 0;
}

void R307_WaitFingerLift(void) {
    uint8_t confirm_code = 0;
    uint8_t gen_img_payload[] = {0x01};
    while (1) {
        R307_SendPacket(0x01, 3, gen_img_payload);
        if (R307_ReceiveResponse(&confirm_code) && confirm_code == 0x02) {
            break;
        }
        HAL_Delay(30);
    }
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART1_UART_Init();
  MX_USART2_UART_Init();
  
  OLED_Init();
  Buttons_AutoDetect_Init();
  
  Load_Database_From_SD();
  char boot_debug[128];
  sprintf(boot_debug, "[DEBUG] Boot Load SD: totalVoters = %d\r\n", totalVoters);
  HAL_UART_Transmit(&huart2, (uint8_t*)boot_debug, strlen(boot_debug), 100);
  
  if (totalVoters == 0) {
      Load_Database_From_Flash();
      sprintf(boot_debug, "[DEBUG] Boot Load Flash: totalVoters = %d\r\n", totalVoters);
      HAL_UART_Transmit(&huart2, (uint8_t*)boot_debug, strlen(boot_debug), 100);
      if (totalVoters > 0) {
          LCD_Print("Loaded from Flash", "");
          HAL_Delay(1000);
      }
  }
  
  if (totalVoters > 0) {
      for (int i = 0; i < totalVoters; i++) {
          sprintf(boot_debug, "[DEBUG] Voter %d: Aadhaar = %s, Slot = %d, Voted = %d\r\n",
                  i, voterDatabase[i].aadhaar, voterDatabase[i].sensor_start_id, voterDatabase[i].has_voted);
          HAL_UART_Transmit(&huart2, (uint8_t*)boot_debug, strlen(boot_debug), 100);
      }
  }
  
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5 | GPIO_PIN_6, GPIO_PIN_RESET);
  
  currentState = STATE_BOOT;
  lastState = STATE_ADMIN_ENROLL_VOTER; 

  while (1)
  {
    char key = Get_Input_Char();
    switch (currentState) {
        case STATE_BOOT:
            if (lastState != STATE_BOOT) {
                LCD_Print("Press * Register", "Press # Verify");
                lastState = STATE_BOOT;
            }
            if (key == '*') {
                LCD_Print("Enter Passcode:", "");
                char pass[4] = {0};
                uint8_t pass_len = 0;
                while (pass_len < 3) {
                    char k = Get_Input_Char();
                    if (k != 0) {
                        pass[pass_len++] = k;
                        LCD_Print("Enter Passcode:", pass);
                    }
                }
                if (strcmp(pass, "*0#") == 0) {
                    Buzzer_Beep(200);
                    currentState = STATE_ADMIN_ENROLL_VOTER;
                } else if (strcmp(pass, "#0*") == 0) {
                    Buzzer_Beep(200);
                    currentState = STATE_SHOW_RESULTS;
                    lastState = STATE_WAIT_AADHAAR;
                } else if (strcmp(pass, "*9#") == 0) {
                    Buzzer_Beep(400);
                    LCD_Print("Erasing databases", "Please Wait...");
                    uint8_t res = R307_EmptyDatabase();
                    char erase_msg[64];
                    sprintf(erase_msg, "[DEBUG] Sensor Erase Status: %s\r\n", res ? "SUCCESS" : "FAILED");
                    HAL_UART_Transmit(&huart2, (uint8_t*)erase_msg, strlen(erase_msg), 100);
                    totalVoters = 0;
                    memset(partyVotes, 0, sizeof(partyVotes));
                    Save_Database_To_SD();
                    Save_Database_To_Flash();
                    Buzzer_Beep(600);
                    LCD_Print("Format Complete", "System Resetted");
                    HAL_Delay(2000);
                    lastState = STATE_WAIT_AADHAAR;
                } else {
                    Buzzer_Error();
                    LCD_Print("Access Denied!", "");
                    HAL_Delay(2000);
                    lastState = STATE_WAIT_AADHAAR;
                }
            }
            else if (key == '#') {
                currentState = STATE_WAIT_AADHAAR;
                input_len = 0;
                memset(input_buffer, 0, sizeof(input_buffer));
            }
            break;
            
        case STATE_ADMIN_ENROLL_VOTER:
            if (totalVoters >= MAX_VOTERS) {
                LCD_Print("Database Full!", "Cannot Register");
                HAL_Delay(2500);
                currentState = STATE_BOOT;
                lastState = STATE_ADMIN_ENROLL_VOTER;
                break;
            }
            
            char reg_aadhaar[13] = {0};
            input_len = 0;
            memset(input_buffer, 0, sizeof(input_buffer));
            LCD_Print("New Aadhaar:", "");
            while (input_len < 12) {
                char k = Get_Input_Char();
                if (k >= '0' && k <= '9' && input_len < 12) {
                    input_buffer[input_len++] = k;
                    LCD_Print("New Aadhaar:", input_buffer);
                }
            }
            strcpy(reg_aadhaar, input_buffer);
            
            uint8_t a_val = Validate_Aadhaar(reg_aadhaar);
            if (a_val == 0) {
                Buzzer_Error();
                LCD_Print("Invalid Aadhaar!", "Try Again");
                HAL_Delay(2000);
                break;
            }
            else if (a_val == 2) {
                Buzzer_Error();
                LCD_Print("Already Existed!", "Try Again");
                HAL_Delay(2000);
                break;
            }
            
            input_len = 0;
            memset(input_buffer, 0, sizeof(input_buffer));
            LCD_Print("DOB (DDMMYYYY):", "");
            while (input_len < 8) {
                char k = Get_Input_Char();
                if (k >= '0' && k <= '9' && input_len < 8) {
                    input_buffer[input_len++] = k;
                    LCD_Print("DOB (DDMMYYYY):", input_buffer);
                }
            }
            uint8_t reg_day = (input_buffer[0]-'0')*10 + (input_buffer[1]-'0');
            uint8_t reg_month = (input_buffer[2]-'0')*10 + (input_buffer[3]-'0');
            uint16_t reg_year = (input_buffer[4]-'0')*1000 + (input_buffer[5]-'0')*100 + (input_buffer[6]-'0')*10 + (input_buffer[7]-'0');
            
            if (!Validate_DOB(reg_day, reg_month, reg_year)) {
                Buzzer_Error();
                LCD_Print("Invalid DOB!", "Try Again");
                HAL_Delay(2000);
                break;
            }
            
            char reg_phone[11] = {0};
            input_len = 0;
            memset(input_buffer, 0, sizeof(input_buffer));
            LCD_Print("Mobile Number:", "");
            while (input_len < 10) {
                char k = Get_Input_Char();
                if (k >= '0' && k <= '9' && input_len < 10) {
                    input_buffer[input_len++] = k;
                    LCD_Print("Mobile Number:", input_buffer);
                }
            }
            strcpy(reg_phone, input_buffer);
            
            char reg_gender = 0;
            LCD_Print("Gender Setup:", "*=Male, #=Female");
            while (reg_gender == 0) {
                char k = Get_Input_Char();
                if (k == '1') {
                    reg_gender = 'M';
                    LCD_Print("Gender Selected:", "Male");
                }
                else if (k == '2') {
                    reg_gender = 'F';
                    LCD_Print("Gender Selected:", "Female");
                }
            }
            HAL_Delay(1000);
            
            uint8_t start_id = totalVoters * 3;
            voterDatabase[totalVoters].has_voted = 0;
            voterDatabase[totalVoters].sensor_start_id = start_id;
            strcpy(voterDatabase[totalVoters].aadhaar, reg_aadhaar);
            strcpy(voterDatabase[totalVoters].phone, reg_phone);
            voterDatabase[totalVoters].day = reg_day;
            voterDatabase[totalVoters].month = reg_month;
            voterDatabase[totalVoters].year = reg_year;
            voterDatabase[totalVoters].gender = reg_gender;
            
            for (int f = 0; f < 3; f++) {
                char finger_msg[32];
                sprintf(finger_msg, "Finger %d: 1st Scan", f + 1);
                LCD_Print("Place Finger", finger_msg);
                Buzzer_Beep(100);
                
                uint8_t quality;
                while (1) {
                    if (R307_CaptureFingerprint(1, &quality)) {
                        break;
                    }
                    HAL_Delay(50);
                }
                
                Buzzer_Beep(100);
                LCD_Print("Lift Finger...", "");
                R307_WaitFingerLift();
                HAL_Delay(100);
                
                sprintf(finger_msg, "Finger %d: 2nd Scan", f + 1);
                LCD_Print("Place Again", finger_msg);
                Buzzer_Beep(100);
                
                while (1) {
                    if (R307_CaptureFingerprint(2, &quality)) {
                        break;
                    }
                    HAL_Delay(50);
                }
                
                LCD_Print("Processing...", "");
                if (R307_RegModel()) {
                    if (R307_StoreTemplate(1, start_id + f)) {
                        Buzzer_Beep(100);
                        LCD_Print("Success!", "Lift Finger");
                        R307_WaitFingerLift();
                        HAL_Delay(100);
                    } else {
                        f--;
                        Buzzer_Error();
                        LCD_Print("Store Error! Retry", "");
                        HAL_Delay(1500);
                    }
                } else {
                    f--;
                    Buzzer_Error();
                    LCD_Print("Merge Error! Retry", "");
                    HAL_Delay(1500);
                }
            }
            
            totalVoters++;
            Save_Database_To_SD();
            Save_Database_To_Flash();
            
            Buzzer_Beep(500);
            LCD_Print("Voter Registered!", "Saved to Database");
            HAL_Delay(2000);
            currentState = STATE_POST_REG_MENU;
            break;
            
        case STATE_POST_REG_MENU:
            if (lastState != STATE_POST_REG_MENU) {
                LCD_Print("*:Next Register", "#:Verify Aadhaar");
                lastState = STATE_POST_REG_MENU;
            }
            if (key == '*') {
                currentState = STATE_ADMIN_ENROLL_VOTER;
            }
            else if (key == '#') {
                currentState = STATE_WAIT_AADHAAR;
                input_len = 0;
                memset(input_buffer, 0, sizeof(input_buffer));
            }
            break;
            
        case STATE_WAIT_AADHAAR:
            if (lastState != STATE_WAIT_AADHAAR) {
                LCD_Print("Search Aadhaar:", "");
                lastState = STATE_WAIT_AADHAAR;
            }
            if (key >= '0' && key <= '9' && input_len < 12) {
                input_buffer[input_len++] = key;
                LCD_Print("Search Aadhaar:", input_buffer);
                
                if (input_len == 12) {
                    HAL_Delay(500);
                    currentVoterIdx = -1;
                    for (int i = 0; i < totalVoters; i++) {
                        if (strcmp(voterDatabase[i].aadhaar, input_buffer) == 0) {
                            currentVoterIdx = i;
                            currentVoter = voterDatabase[i];
                            break;
                        }
                    }
                    
                    if (currentVoterIdx == -1) {
                        Buzzer_Error();
                        LCD_Print("Not Found!", "Try Again");
                        HAL_Delay(2000);
                        input_len = 0;
                        memset(input_buffer, 0, sizeof(input_buffer));
                        lastState = STATE_WAIT_AADHAAR;
                        currentState = STATE_BOOT;
                    } 
                    else {
                        Buzzer_Beep(200);
                        uint8_t age_eligible = 0;
                        if (2026 - currentVoter.year > 18) {
                            age_eligible = 1;
                        } else if (2026 - currentVoter.year == 18) {
                            if (currentVoter.month < 7) {
                                age_eligible = 1;
                            } else if (currentVoter.month == 7) {
                                if (currentVoter.day <= 3) {
                                    age_eligible = 1;
                                }
                            }
                        }
                        
                        if (!age_eligible) {
                            Buzzer_Error();
                            LCD_Print("Age Under 18!", "Not Eligible");
                            HAL_Delay(3000);
                            input_len = 0;
                            memset(input_buffer, 0, sizeof(input_buffer));
                            lastState = STATE_WAIT_AADHAAR;
                            currentState = STATE_BOOT;
                            break;
                        }
                        
                        if (currentVoter.has_voted) {
                            Buzzer_Error();
                            LCD_Print("Already Voted!", "Access Denied");
                            HAL_Delay(3000);
                            input_len = 0;
                            memset(input_buffer, 0, sizeof(input_buffer));
                            lastState = STATE_WAIT_AADHAAR;
                            currentState = STATE_BOOT;
                            break;
                        }
                        
                        char details_dob[32];
                        char details_gender[32];
                        char details_phone[32];
                        sprintf(details_dob, "DOB: %02d/%02d/%04d", currentVoter.day, currentVoter.month, currentVoter.year);
                        sprintf(details_gender, "Gender: %s", (currentVoter.gender == 'M') ? "Male" : "Female");
                        sprintf(details_phone, "Phone: %s", currentVoter.phone);
                        
                        LCD_Print("Voter Found!", details_dob);
                        HAL_Delay(2000);
                        LCD_Print(details_phone, details_gender);
                        HAL_Delay(2000);
                        
                        LCD_Print("Place Finger to", "Verify");
                        Buzzer_Beep(100);
                        
                        uint8_t quality;
                        while (1) {
                            if (R307_CaptureFingerprint(1, &quality)) {
                                break;
                            }
                            HAL_Delay(50);
                        }
                        
                        LCD_Print("Verifying...", "");
                        uint8_t verified = 0;
                        uint16_t matched_page = 0xFFFF;
                        uint16_t match_score = 0;
                        uint16_t start_slot = currentVoter.sensor_start_id;
                        // Compare directly against the 3 templates registered for this voter:
                        for (int i = 0; i < 3; i++) {
                            uint16_t current_slot = start_slot + i;
                            if (R307_LoadTemplate(2, current_slot)) {
                                uint16_t score = 0;
                                if (R307_Match(&score)) {
                                    char debug_buf[128];
                                    sprintf(debug_buf, "[DEBUG] Slot: %d, Match Score: %d\r\n", current_slot, score);
                                    HAL_UART_Transmit(&huart2, (uint8_t*)debug_buf, strlen(debug_buf), 100);
                                    
                                    if (score >= 50) {
                                        verified = 1;
                                        matched_page = current_slot;
                                        match_score = score;
                                        break;
                                    }
                                }
                            }
                        }
                        
                        char score_msg[32];
                        sprintf(score_msg, "P:%d S:%d Sc:%d", (verified ? matched_page : 0xFFFF), start_slot, (verified ? match_score : 0));
                        
                        if (verified) {
                            Buzzer_Beep(600);
                            LCD_Print("Verified!", "Cast Your Vote");
                            HAL_Delay(1000);
                            
                            LCD_Print("BJP INC AAP BSP", "Press Candidate");
                            int candidate = -1;
                            while (candidate == -1) {
                                candidate = Get_Voted_Candidate();
                                HAL_Delay(20);
                            }
                            
                            const char *party_name = "Unknown";
                            switch(candidate) {
                                case 0: party_name = "BJP"; partyVotes[0]++; break;
                                case 1: party_name = "INC"; partyVotes[1]++; break;
                                case 2: party_name = "AAP"; partyVotes[2]++; break;
                                case 3: party_name = "BSP"; partyVotes[3]++; break;
                                case 4: party_name = "NOTA"; partyVotes[4]++; break;
                            }
                            
                            char vote_msg[32];
                            sprintf(vote_msg, "Voted: %s", party_name);
                            LCD_Print("Vote Casted!", vote_msg);
                            Buzzer_Beep(800);
                            
                            voterDatabase[currentVoterIdx].has_voted = 1;
                            Save_Database_To_SD();
                            Save_Database_To_Flash();
                            HAL_Delay(2000);
                        } else {
                            Buzzer_Error();
                            LCD_Print("Not Verified", score_msg);
                            HAL_Delay(4000);
                        }
                        
                        input_len = 0;
                        memset(input_buffer, 0, sizeof(input_buffer));
                        lastState = STATE_WAIT_AADHAAR;
                        currentState = STATE_BOOT;
                    }
                }
            }
            break;

        case STATE_SHOW_RESULTS:
            if (lastState != STATE_SHOW_RESULTS) {
                uint32_t tot = partyVotes[0] + partyVotes[1] + partyVotes[2] + partyVotes[3] + partyVotes[4];
                char line1[32];
                char line2[64];
                sprintf(line1, "Total Votes:%lu", tot);
                sprintf(line2, "B:%u I:%u A:%u B:%u N:%u", partyVotes[0], partyVotes[1], partyVotes[2], partyVotes[3], partyVotes[4]);
                LCD_Print(line1, line2);
                lastState = STATE_SHOW_RESULTS;
            }
            if (key == '*') {
                Buzzer_Beep(100);
                lastState = STATE_WAIT_AADHAAR;
                currentState = STATE_BOOT;
            }
            break;
    }
  }
}

void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  if (HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1) != HAL_OK)
  {
    Error_Handler();
  }

  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSI;
  RCC_OscInitStruct.PLL.PLLM = 1;
  RCC_OscInitStruct.PLL.PLLN = 10;
  RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV7;
  RCC_OscInitStruct.PLL.PLLQ = RCC_PLLQ_DIV2;
  RCC_OscInitStruct.PLL.PLLR = RCC_PLLR_DIV2;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK|RCC_CLOCKTYPE_SYSCLK
                              |RCC_CLOCKTYPE_PCLK1|RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_SYSCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_4) != HAL_OK)
  {
    Error_Handler();
  }
}

static void MX_USART1_UART_Init(void)
{
  huart1.Instance = USART1;
  huart1.Init.BaudRate = 57600;
  huart1.Init.WordLength = UART_WORDLENGTH_8B;
  huart1.Init.StopBits = UART_STOPBITS_1;
  huart1.Init.Parity = UART_PARITY_NONE;
  huart1.Init.Mode = UART_MODE_TX_RX;
  huart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart1.Init.OverSampling = UART_OVERSAMPLING_16;
  huart1.Init.OneBitSampling = UART_ONE_BIT_SAMPLE_DISABLE;
  huart1.AdvancedInit.AdvFeatureInit = UART_ADVFEATURE_NO_INIT;
  HAL_UART_Init(&huart1);
}

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
  HAL_UART_Init(&huart2);
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_0 | GPIO_PIN_1 | GPIO_PIN_7 | GPIO_PIN_8, GPIO_PIN_SET); // Keep active-low OLED CS (PA0) and SD CS (PA1) HIGH at boot
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5 | GPIO_PIN_6, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_4 | GPIO_PIN_6, GPIO_PIN_SET); // Keep active-low Buzzer OFF (High) at boot
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_0 | GPIO_PIN_4 | GPIO_PIN_5 | GPIO_PIN_6 | GPIO_PIN_8, GPIO_PIN_SET);

  GPIO_InitStruct.Pin = GPIO_PIN_5 | GPIO_PIN_6;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_0 | GPIO_PIN_1 | GPIO_PIN_7 | GPIO_PIN_8;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_MEDIUM;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_4;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_4 | GPIO_PIN_6;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_0 | GPIO_PIN_4 | GPIO_PIN_5 | GPIO_PIN_6 | GPIO_PIN_8;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_1 | GPIO_PIN_2 | GPIO_PIN_3;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_7;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_0|GPIO_PIN_3|GPIO_PIN_5|GPIO_PIN_10;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
}

void Error_Handler(void)
{
  __disable_irq();
  while (1) {}
}
