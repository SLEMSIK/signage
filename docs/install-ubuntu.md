# Установка Signage на Ubuntu

Установка на **Ubuntu Server 22.04 / 24.04** такая же, как на Debian, — тем же скриптом `deploy/install.sh` (Node.js 22 + PM2, без Docker). Полная инструкция: [install-debian.md](install-debian.md). Здесь — только отличия Ubuntu.

## Установка ОС

Образ: Ubuntu Server 24.04 LTS — <https://ubuntu.com/download/server>. Параметры VM в Proxmox — как в [install-debian.md, раздел 2](install-debian.md#2-виртуальная-машина-в-proxmox).

В установщике:

1. **Type of install**: Ubuntu Server (не minimized).
2. **Network**: DHCP или сразу **Edit IPv4 → Manual** (адрес, шлюз, DNS).
3. **Storage**: Use an entire disk, LVM — по умолчанию. ⚠ Установщик отдаёт системе только половину диска — после установки:
   ```bash
   sudo lvextend -l +100%FREE -r /dev/ubuntu-vg/ubuntu-lv
   ```
4. **Profile**: имя сервера `signage`, ваш пользователь (`itadmin`) — у него сразу есть `sudo`.
5. **SSH**: ✅ Install OpenSSH server.
6. **Featured snaps**: ничего не выбирайте.

## Установка Signage

Как в [install-debian.md, раздел 5](install-debian.md#5-установка-signage-скриптом):

```bash
wget -O install.sh https://raw.githubusercontent.com/SLEMSIK/signage/main/deploy/install.sh
sudo bash install.sh
```

## Отличия от Debian

| Что | Ubuntu |
|---|---|
| Статический IP | netplan: `/etc/netplan/*.yaml` (скрипт предложит закрепить адрес и запишет `/etc/netplan/99-signage-static.yaml`) |
| DNS | через systemd-resolved; скрипт пишет `/etc/systemd/resolved.conf.d/signage-dns.conf`, если DNS не работает |
| `sudo` | есть сразу |
| Брандмауэр | ufw установлен, но выключен. Включить: `sudo ufw allow OpenSSH && sudo ufw allow 8080/tcp && sudo ufw enable` |

Статический адрес вручную (`ip -br addr` — имя интерфейса):

```bash
echo 'network: {config: disabled}' | sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
sudo nano /etc/netplan/50-cloud-init.yaml
```

```yaml
network:
  version: 2
  ethernets:
    ens18:
      dhcp4: false
      addresses: [10.33.44.20/24]
      routes:
        - to: default
          via: 10.33.44.1
      nameservers:
        addresses: [10.33.44.1]
```

```bash
sudo chmod 600 /etc/netplan/50-cloud-init.yaml
sudo netplan try
```

Всё остальное — проверка, экраны, управление командой `signage`, неполадки — в [install-debian.md](install-debian.md).
