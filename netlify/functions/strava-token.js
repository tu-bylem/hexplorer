// Netlify Function: proxy dla Strava OAuth token exchange
// Strava blokuje bezpośrednie żądania z przeglądarki (CORS),
// ta funkcja działa jako mini-backend i pośredniczy w wymianie tokenu.

exports.handler = async function (event) {
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    // Obsługa CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
    }

    try {
        const response = await fetch('https://www.strava.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: event.body,
        });

        const data = await response.json();

        return {
            statusCode: response.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: error.message }),
        };
    }
};
