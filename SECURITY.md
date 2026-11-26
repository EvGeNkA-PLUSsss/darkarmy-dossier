# Security Policy

## Поддерживаемые версии

Исправления безопасности выходят для актуальной ветки `main`.

## Как сообщить об уязвимости

Не создавайте публичный issue с эксплойтом. Напишите владельцу репозитория
(EvGeNkA-PLUSsss) через GitHub Security Advisories:
<https://github.com/EvGeNkA-PLUSsss/darkarmy-dossier/security/advisories/new>

Укажите:
- версию/коммит;
- шаги воспроизведения;
- влияние и возможные пути эксплуатации;
- PoC, если есть.

## Базовые требования к установке

- `NODE_ENV=production`;
- постоянный `SESSION_SECRET`;
- HTTPS через reverse proxy (nginx/Caddy);
- не выставлять `7561` в интернет напрямую;
- `TRUST_PROXY=1` за прокси;
- регулярные бэкапы `data/` и `PROJECTS_ROOT`;
- не запускать от root.

Полный чек-лист — [documenti/08-security.md](documenti/08-security.md).
