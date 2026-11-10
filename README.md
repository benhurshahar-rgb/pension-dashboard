# דשבורד פנסיות וביטוחים – שחר ולוטם

אתר סטטי (GitHub Pages) שמתעדכן כל בוקר דרך GitHub Actions. כל הנתונים האישיים מוצפנים – ה־repo ציבורי אבל אין בו שום מספר גלוי.

## איך זה עובד
- `data/state.sealed.json` – כל הנתונים, מוצפנים למפתח שנגזר מהסוד `DASHBOARD_PASSWORD`.
- `keys/public.json` – מפתח ציבורי (האתר מפרסם אותו ב־`/public.json`). איתו אפשר להצפין נתונים חדשים בלי לדעת את הסיסמה.
- `scripts/update.mjs` – רץ כל יום (קריאה בלבד, לא כותב ל־repo): פותח את הנתונים, מושך מדדים ושערים (S&P 500, ת״א 125, MSCI World, דולר/יורו), מחשב הערכת שווי לכל קופה, ומפרסם את הדף מוצפן בסיסמה.
- `site/index.html` – הדף. מפענח את הנתונים בדפדפן אחרי הקלדת הסיסמה.

## הערכת השווי היומית
כל קופה = היתרה בדוח האחרון × השינוי במדד של המסלול שלה מאז. כל דוח חדש (מסלקה / קופה / Vanguard / Irish Life) מעדכן את היתרה לאמת.

## עדכון נתונים
```
node scripts/seal.mjs state.plain.json data/state.sealed.json
git add data/state.sealed.json && git commit -m "data update" && git push
```
לעולם לא לעשות commit לקובץ הלא־מוצפן.
